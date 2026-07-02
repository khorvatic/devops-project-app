# Sigurnosno izvješće — Trivy skeniranje kontejnerskih slika

## Pregled

Sve tri aplikacijske slike (`api`, `frontend`, `worker`) skeniraju se automatski u
CI pipelineu (`.github/workflows/ci.yml`, job `security-scan`) alatom
[Trivy](https://trivy.dev/) nakon svakog builda. Pipeline koristi **quality
gate**: build se prekida (exit kod 1) ako se pronađe bilo koja ranjivost
razine HIGH ili CRITICAL koja ima objavljen popravak (`ignore-unfixed: true`
namjerno isključuje ranjivosti bez dostupnog fixa, jer na njih trenutno ne
možemo utjecati).

Skenira se **produkcijska** (`target: production`) faza slike — ne razvojna
(`dev`) faza — jer je to varijanta koja bi se stvarno deployala.

## Prvi nalaz (prije korekcije)

Inicijalni scan je za sva tri servisa prijavio identičan skup nalaza:

| Kategorija | Komponenta | CVE | Severity | Izvor |
|---|---|---|---|---|
| OS paket (Alpine) | `libcrypto3` / `libssl3` (OpenSSL) | CVE-2026-45447 | HIGH | Zastarjela verzija OpenSSL-a u base slici `node:20-alpine` |
| Node.js paket | `cross-spawn` | CVE-2024-21538 | HIGH | Tranzitivna ovisnost ugrađenog `npm` CLI-ja |
| Node.js paket | `glob` | CVE-2025-64756 | HIGH | Tranzitivna ovisnost ugrađenog `npm` CLI-ja |
| Node.js paket | `minimatch` | CVE-2026-26996, CVE-2026-27903, CVE-2026-27904 | HIGH | Tranzitivna ovisnost ugrađenog `npm` CLI-ja |
| Node.js paket | `sigstore` | CVE-2026-48815 | HIGH | Tranzitivna ovisnost ugrađenog `npm` CLI-ja |
| Node.js paket | `tar` | CVE-2026-23745, CVE-2026-23950, CVE-2026-24842, CVE-2026-26960, CVE-2026-29786, CVE-2026-31802 | HIGH | Tranzitivna ovisnost ugrađenog `npm` CLI-ja |

Ukupno: 14 HIGH nalaza po slici, 0 CRITICAL.

## Analiza uzroka

Bitno zapažanje: **nijedan** od pogođenih Node.js paketa (`cross-spawn`,
`glob`, `minimatch`, `sigstore`, `tar`) nije direktna ni tranzitivna ovisnost
same aplikacije (`api/package.json`, `frontend/package.json`,
`worker/package.json` — sve tri koriste samo `dotenv`, `express`, `pg`,
`redis`, `uuid`). Provjereno naredbom:

```bash
docker run --rm -it ticketing-api sh
find / -path "*/node_modules/tar" -maxdepth 8
```

Nalaz potvrđuje da se ti paketi nalaze unutar `/usr/local/lib/node_modules/npm/`
— dio su **npm CLI-ja koji je ugrađen u službenu `node:20-alpine` sliku**,
ne dio aplikacijskog koda. Produkcijska slika pokreće aplikaciju direktno
(`CMD ["node", "src/server.js"]`) i nikad ne poziva `npm` u runtimeu, pa je
sam npm alat unutar produkcijske slike suvišan — prisutan je samo zato što
ga base image donosi po defaultu.

OpenSSL nalaz (`libcrypto3`/`libssl3`) je odvojen slučaj: fix je već
objavljen (`3.5.7-r0`) u trenutku skeniranja, ali `node:20-alpine` slika je
bila povučena prije nego je ta zakrpana verzija ušla u Alpine paket
repozitorij.

## Korektivne mjere

1. **Uklonjen npm iz produkcijske faze svih triju Dockerfile-a.** Budući da
   npm nije potreban za pokretanje aplikacije, uklanjanje smanjuje attack
   surface i eliminira sve njegove tranzitivne ovisnosti odjednom, umjesto
   pojedinačnog "whitelistanja" ili čekanja uzvodnih popravaka:
```dockerfile
   RUN rm -rf /usr/local/lib/node_modules/npm \
       /usr/local/bin/npm \
       /usr/local/bin/npx \
       /usr/local/lib/node_modules/corepack \
       /usr/local/bin/corepack
```
2. **Dodan `apk upgrade` korak** prije kopiranja aplikacijskog koda, da se
   povuku najnovije zakrpane verzije Alpine OS paketa dostupne u trenutku
   builda:
```dockerfile
   RUN apk update && apk upgrade --no-cache
```
3. Oba koraka izvršena **prije** prebacivanja na `USER node` u Dockerfileu,
   jer zahtijevaju root ovlasti koje non-root korisnik nema (i ne bi smio
   imati).

## Rezultat nakon korekcije

Ponovljeni scan nakon primjene navedenih izmjena (commit "Harden production
images: remove npm, upgrade OS packages to fix Trivy findings") prošao je
bez ijednog HIGH ili CRITICAL nalaza za sva tri servisa (`api`, `frontend`,
`worker`). Pipeline `security-scan` job: **passed**.

## Napomena o kontinuiranom praćenju

Ovo izvješće odražava stanje u trenutku pisanja. Budući da se nove
ranjivosti otkrivaju kontinuirano, isti Trivy quality gate se izvršava na
**svaki push** prema `main` grani (`.github/workflows/ci.yml`), pa se svaka
buduća regresija (npr. nova ranjivost u nekoj od preostalih ovisnosti,
`express`, `pg`, `redis`, `uuid`, `dotenv`) automatski otkriva prije nego
slika stigne do produkcije.