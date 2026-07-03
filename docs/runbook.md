# Runbook — Secure Event Ticketing Platform

Ovaj dokument opisuje stvarne incidente otkrivene i riješene tijekom razvoja i testiranja projekta (lokalni Kubernetes klaster, `kind`). Svaki scenarij prati isti obrazac: simptom → dijagnoza → analiza uzroka → korekcija → validacija. Naredbe pretpostavljaju `kubectl` kontekst postavljen na `ticketing` namespace.

---

## Incident 1 — Worker readiness probe stalno pada (0/1 Ready)

### Simptom

Nakon deploya `worker` Deploymenta, pod ostaje trajno `0/1 Ready` unatoč statusu `Running`:

```
worker-69b74cd7f7-qflfd     0/1     Running   0          9m
```

### Dijagnoza

```bash
kubectl describe pod -l app=worker
```

Events pokazuju:

```
Warning  Unhealthy  kubelet  Readiness probe failed: Get "http://10.244.0.8:9000/readyz":
context deadline exceeded (Client.Timeout exceeded while awaiting headers)
```

Provjera `/healthz` (isti pod, isti port) prolazi bez problema:

```bash
kubectl exec -it deploy/worker -- wget -qO- http://localhost:9000/healthz
# {"status":"ok","service":"worker"}
```

Budući da je `/healthz` aktivan, a `/readyz` na istom portu i istoj pod adresi "visi" do timeouta, problem nije mrežni — problem je specifično unutar `/readyz` logike.

### Analiza uzroka

Worker koristi jednu Redis konekciju (`redisClient`) i za blokirajuću `BRPOP` petlju (`redisClient.brPop(queueName, 0)`, gdje `0` znači "čekaj beskonačno") i za `redisClient.ping()` unutar `/readyz` rute. Redis klijenti šalju naredbe redom, na istoj konekciji — dok `BRPOP` čeka (što čini gotovo uvijek, osim kad se baš u tom trenutku kupuje karta), svaka sljedeća naredba na istom klijentu (uključujući `ping()`) staje iza nje u red i nikad ne dobiva odgovor.

### Korekcija

Uvedena zasebna Redis konekcija isključivo za blokirajuću petlju, koristeći `redisClient.duplicate()`:

```js
const blockingClient = redisClient.duplicate();
// ...
await blockingClient.connect();
// BRPOP ide preko blockingClient, /readyz i dalje koristi (sad slobodan) redisClient
```

### Validacija

```bash
kubectl exec -it deploy/worker -- wget -qO- http://localhost:9000/readyz
# {"status":"ready"}
kubectl get pods -l app=worker
# worker-...   1/1   Running   0
```

---

## Incident 2 — Worker u CrashLoopBackOff nakon kreiranja novog klastera

### Simptom

Pri svježem deployu svih servisa odjednom (npr. nakon `kind delete cluster`
+ ponovno `kubectl apply -f k8s/`), `worker` pod ulazi u `CrashLoopBackOff`:

```
worker-69b74cd7f7-qflfd   0/1   CrashLoopBackOff   1 (10s ago)   40s
```

### Dijagnoza

```bash
kubectl logs -l app=worker --previous
```

Nema eksplicitne greške u logu, proces jednostavno završi rano jer `pgPool.query("SELECT 1")` na startu baci grešku (Postgres pod je u tom trenutku još `ContainerCreating`).

### Analiza uzroka

Kubernetes ne garantira redoslijed pokretanja podova iz različitih Deploymenta — za razliku od Docker Compose-a (`depends_on: condition: service_healthy`), svi podovi kreću usporedno. Worker se pokušao spojiti na Postgres prije nego što je on bio spreman primati konekcije, `pgPool.query` je bacio grešku, `startWorker().catch()` je pozvao `process.exit(1)`.

### Korekcija

Dodana retry petlja s ograničenim brojem pokušaja i pauzom, umjesto instantog pada na prvi neuspjeh:

```js
async function waitForPostgres(retries = 10, delayMs = 3000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await pgPool.query("SELECT 1");
            return;
        } catch (error) {
            if (attempt === retries) throw error;
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
}
```

### Validacija

Nakon redeploya, `worker` pod prolazi kroz eventualne retry pokušaje (vidljivo u logovima kao `Postgres nije dostupan (pokušaj X/10)`) i uspješno starta bez `CrashLoopBackOff`, čak i kad je Postgres pod u tom trenutku tek `ContainerCreating`.

---

## Incident 3 — Pad baze ruši API proces umjesto graceful degradacije

### Simptom

Namjerna simulacija pada baze (`kubectl scale deployment postgres --replicas=0`) uzrokuje da `api` podovi ne prestanu samo biti ready, nego se stvarno sruše i restartaju:

```bash
kubectl scale deployment postgres --replicas=0
kubectl get pods -l app=api
# api-...   0/1   Running   1 (48s ago)   5m30s
```

`RESTARTS` stupac raste, iako je očekivano ponašanje bilo samo privremeni `0/1 Ready` status bez restarta procesa.

### Dijagnoza

```bash
kubectl logs <pod-ime> --previous
```

```
node:events:502
      throw er; // Unhandled 'error' event
      ^
error: terminating connection due to administrator command
  ...
  code: '57P01', severity: 'FATAL'
Emitted 'error' event on BoundPool instance at:
    at Client.idleListener (/app/node_modules/pg-pool/index.js:62:10)
```

### Analiza uzroka

`pg` biblioteka održava pool neaktivnih (idle) konekcija. Kad Postgres aktivno zatvori konekcije (npr. gašenje/skaliranje na 0), `pg-pool` emitira `"error"` event na samom Pool objektu. Node.js smatra neuhvaćeni `"error"` event na EventEmitteru fatalnom greškom i ruši proces — čak i uz `try/catch` oko svih upita, jer ovaj event nije vezan za pojedini upit nego za samu pool infrastrukturu.

### Korekcija

Dodan eksplicitan `error` listener na `pgPool`, u `api/src/app.js` i `worker/src/worker.js`:

```js
pgPool.on("error", (error) => {
    console.error("Neočekivana greška na neaktivnoj Postgres konekciji:", error.message);
});
```

Napomena: ova izmjena je zahtijevala i ažuriranje Jest mocka za `pg.Pool` (dodan `on: jest.fn()`) jer je test suite mockirao Pool s ograničenim setom metoda koji više nije odgovarao stvarnom korištenom API-ju — CI je ispravno uhvatio tu regresiju prije nego je stigla u produkciju.

### Validacija

```bash
kubectl scale deployment postgres --replicas=0
sleep 20
kubectl get pods -l app=api
# api-...   0/1   Running   0   1m40s    <- RESTARTS ostaje 0

kubectl scale deployment postgres --replicas=1
kubectl get pods -w   # pričekati 1/1
curl http://localhost/api/readyz
# {"status":"ready"}
```

Proces sad korektno prijavljuje "nisam spreman" umjesto da se ruši — pravi primjer graceful degradacije.

---

## Incident 4 — Rollback na `:latest` tag ne vraća stariju verziju koda

### Simptom

Tijekom demonstracije rollbacka, `kubectl rollout undo deployment/api --to-revision=1` je uspješno prijavljen (`deployment.apps/api rolled back`), ali `curl http://localhost/api/healthz` je i dalje vraćao trenutnu (novu) verziju koda, ne stariju.

### Dijagnoza

```bash
kubectl rollout history deployment/api --revision=1
# Image: ghcr.io/.../api:latest
```

### Analiza uzroka

Revizija #1 je referencirala pomični tag `:latest`, ne fiksan git SHA. Svaki `publish` CI job ažurira oba taga (SHA i `latest`) na najnoviju sliku pa `:latest` danas pokazuje na potpuno drugačiji sadržaj nego u trenutku kad je revizija #1 nastala. Kubernetes je vratio pod specifikaciju iz revizije #1 (koja doslovno kaže "koristi `:latest`"), ali kako taj tag nije zamrznuta točka u vremenu, stvarni rezultat je bio povlačenje najnovije slike, ne stare.

### Korekcija / preporuka

Svi Deploymenti u produkciji trebaju referencirati fiksne, nepromjenjive git SHA tagove, ne `:latest`. `:latest` je prihvatljiv samo za brzo lokalno testiranje, nikad za deployment čija povijest revizija treba biti pouzdana za rollback.

### Validacija

Ponovljen rollback prema fiksnom, starijem SHA tagu (`git rev-parse HEAD~1`) je ispravno vratio odgovor bez novog `version` polja — potvrđuje da rollback radi pouzdano uz fiksne tagove.

---

## Incident 5 — Loš image tag

### Simptom

Namjerna promjena image taga na nepostojeći uzrokuje `ImagePullBackOff` stanje.

```bash
kubectl set image deployment/api api=ghcr.io/khorvatic/devops-project-app/api:ne-postoji-ovaj-tag
kubectl get pods -l app=api -w
```

```
api-544fc44f7c-dwrmm   1/1     Running            0          4m11s
api-544fc44f7c-lfn4v   1/1     Running            0          4m1s
api-bbcc6f7-mkzp8      0/1     ImagePullBackOff   0          45s
```

### Dijagnoza

```bash
kubectl describe pod -l app=api
```

Events: `Failed to pull image "...api:ne-postoji-ovaj-tag": ... manifest unknown`.

### Ključno zapažanje — servis ostaje dostupan

Tijekom cijelog incidenta, oba stara `api` poda ostaju `1/1 Running`, a `curl http://localhost/api/healthz` nastavlja vraćati ispravan odgovor. Rolling update strategija Kubernetesa ne gasi stare, zdrave podove dok novi nisu uspješno prošli readiness provjeru — pokvaren deploy zato ne uzrokuje prekid usluge, samo sprječava napredovanje ažuriranja.

### Korekcija

```bash
kubectl set image deployment/api api=ghcr.io/khorvatic/devops-project-app/api:<poznat-dobar-sha>
kubectl rollout status deployment/api
```

### Validacija

```bash
kubectl get pods -l app=api
# svi podovi 1/1 Running, bez ImagePullBackOff
curl http://localhost/api/healthz
```