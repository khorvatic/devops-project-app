# Secure Event Ticketing Platform (Sample DevSecOps Project)

Ovaj repozitorij je referentni uzorak aplikacije za kolegij **Uvod u DevOps - DevSecOps**.
Prikazuje cijeli tok: lokalni razvoj kroz Compose i produkcijski deployment kroz Kubernetes manifeste.

## Arhitektura

- `frontend` - web UI za pregled evenata i kupnju karata
- `api` - REST API za evente, narudzbe i health provjere
- `worker` - pozadinska obrada queue poruka
- `postgres` - trajna pohrana narudzbi
- `redis` - queue/cache sloj

## Lokalno pokretanje (developer environment)

Preduvjeti: Docker Desktop (s uključenim WSL2 backendom na Windowsu) i Docker Compose (dolazi ugrađen u Docker Desktop).

### Prvo pokretanje

1. Kopiraj primjer environment varijabli:
```bash
   cp .env.example .env
```
   Vrijednosti u `.env.example` su već ispravno postavljene za rad unutar Docker mreže — za lokalni razvoj ništa nije potrebno mijenjati.

2. Pokreni cijeli stack (build + start svih 5 servisa):
```bash
   docker compose up -d --build
```
   `-d` pokreće kontejnere u pozadini, `--build` osigurava da se slike za `api`/`frontend`/`worker` izgrade prije starta.

3. Provjeri da su svi servisi zdravi:
```bash
   docker compose ps
```
   `postgres`, `redis` i `api` bi trebali imati status `healthy`.

Automatski se koristi i `compose.override.yaml`, koji za `api`, `worker` i `frontend` builda **razvojnu** varijantu slike (uključuje `nodemon`) i montira lokalni `src` folder u kontejner — svaka promjena koda se odmah primjenjuje bez ručnog rebuilda.

### Svakodnevni rad

- Pokreni stack: `docker compose up -d`
- Prati logove uživo (npr. za `api`): `docker compose logs -f api`
- Restartaj jedan servis: `docker compose restart api`
- Zaustavi stack (podaci u Postgresu ostaju sačuvani): `docker compose down`
- Zaustavi stack i **obriši** sve podatke (čisto stanje): `docker compose down -v`

### Pokretanje produkcijske varijante slika lokalno

Za testiranje "čistih" produkcijskih slika (bez nodemona, bez mountanog koda), eksplicitno isključi override datoteku:

```bash
docker compose -f compose.yaml up -d --build
```

### Brza validacija funkcionalnosti

1. Health API:
   ```bash
   curl http://localhost:8080/healthz
   curl http://localhost:8080/readyz
   ```
2. Dohvati evente:
   ```bash
   curl http://localhost:8080/events
   ```
3. Posalji narudzbu:
   ```bash
   curl -X POST http://localhost:8080/tickets/purchase \
     -H "Content-Type: application/json" \
     -d '{"eventId":"evt-1001","customerEmail":"student@example.com","quantity":2}'
   ```
4. Provjeri obradene narudzbe:
   ```bash
   curl http://localhost:8080/tickets/orders
   ```
5. UI:
   - Otvori `http://localhost:3000`

## Sigurnosni elementi

- Multi-stage Docker build i non-root runtime korisnik
- Secret + ConfigMap odvojena konfiguracija
- Liveness/Readiness probe
- Resource requests/limits
- ServiceAccount + RBAC
- NetworkPolicy segmentacija
- Trivy skeniranje slika u CI pipelineu

Detalji skeniranja: `docs/security/image-scan-report.md`