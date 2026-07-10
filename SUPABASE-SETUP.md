# Supabase-setup — Gedeelde gezinschecklist

Dit koppelt de "Reisbenodigdheden"-checklist aan een gedeelde database, zodat
Henk Jan, Jessica, Oscar en Lucas dezelfde vinkjes zien — op elk apparaat.

**Scope**: alleen de checklist-voortgang. Vluchten, hotels, boekingen en
onderzoek blijven in `dashboard-data.json` op GitHub Pages — die gaan niet
naar Supabase.

**Status**: dit is nog niet geactiveerd. Zolang je onderstaande stappen niet
hebt uitgevoerd, blijft het dashboard gewoon werken met alleen
apparaat-lokale opslag (huidige gedrag, niets breekt).

---

## 1. Supabase-project aanmaken

1. Ga naar [supabase.com](https://supabase.com) → **Start your project** → log in met GitHub of e-mail.
2. **New project** → naam bijvoorbeeld `kortes-trip-2026` → kies een sterk database-wachtwoord (bewaar dit in je password manager, niet in dit dashboard) → kies regio **eu-central** (dichtstbij).
3. Wacht ~2 min tot het project actief is.

## 2. Tabellen aanmaken

1. In het Supabase-dashboard: **SQL Editor** (linkermenu) → **New query**.
2. Plak de volledige inhoud van `05-dashboard/supabase-schema.sql` uit deze projectmap.
3. **Run**. Dit maakt 3 tabellen (`trip_workspaces`, `trip_members`, `checklist_state`) + Row Level Security-beleid + een seed-rij voor de workspace.

## 3. Row Level Security controleren

RLS staat al aan via het schema-script. Controleer in **Authentication → Policies**
dat je op alle 3 tabellen groene "RLS enabled"-badges ziet.

**Waarom dit belangrijk is**: het dashboard staat publiek op GitHub Pages, dus
de database-sleutel die in de JavaScript-code komt te staan is voor iedereen
zichtbaar. RLS zorgt dat die sleutel alleen data van *jullie eigen workspace*
kan lezen/schrijven — nooit van andere Supabase-gebruikers.

## 4. Authenticatie instellen (Magic Link — aanbevolen)

**Waarom Magic Link**: geen wachtwoorden om te onthouden of te lekken, werkt
met één tik in Safari op iPhone, geen ingewikkelde account-flow tijdens de reis.

1. **Authentication → Providers** → zorg dat **Email** aan staat.
2. **Authentication → URL Configuration**:
   - **Site URL**: `https://vondlw.github.io/kortes-trip-2026/`
   - **Redirect URLs**: voeg toe `https://vondlw.github.io/kortes-trip-2026/`
3. **Authentication → Email Templates → Magic Link**: standaardtekst is prima, evt. Nederlands aanpassen.

## 5. Gezinsleden toevoegen

Dit vereist e-mailadressen van Henk Jan, Jessica, Oscar en Lucas — die zijn nu
niet aangeleverd, dus dit is een **handmatige stap voor jou**:

1. **Authentication → Users → Add user** → voer elk e-mailadres in (of laat ze zelf inloggen via Magic Link op het dashboard — dan verschijnen ze hier automatisch na eerste keer inloggen).
2. Noteer elke gegenereerde `user_id` (UUID, zichtbaar in de Users-lijst).
3. Ga naar **Table Editor → trip_members** → **Insert row** voor elk gezinslid:
   - `workspace_id`: kopieer de UUID uit `trip_workspaces` (Table Editor → trip_workspaces)
   - `user_id`: de UUID van die persoon uit stap 2
   - `display_name`: `Henk Jan` / `Jessica` / `Oscar` / `Lucas`
   - `role`: `owner` voor Henk Jan, `member` voor de rest

## 6. Realtime aanzetten

1. **Database → Replication** → zoek `supabase_realtime` publicatie.
2. Vink **checklist_state** aan.
3. Save.

Zonder deze stap werkt alles nog steeds, maar dan zie je wijzigingen van
anderen pas na een pagina-refresh in plaats van direct.

## 7. Frontend configureren

1. In **Project Settings → API** vind je:
   - **Project URL** (iets als `https://xxxxx.supabase.co`)
   - **anon / public key** (lange string, begint met `eyJ...`)
2. Open `05-dashboard/sync.js` in dit project en vul bovenaan in:
   ```js
   const SUPABASE_URL = 'https://xxxxx.supabase.co';
   const SUPABASE_ANON_KEY = 'eyJ...';
   ```
3. **Belangrijk**: gebruik ALLEEN de `anon`/`public` key hier — nooit de
   `service_role`-sleutel. De anon-key is bedoeld om publiek zichtbaar te zijn;
   RLS beschermt de data, niet geheimhouding van deze sleutel.
4. Commit + push naar GitHub zoals gebruikelijk.

## 8. Testen — synchronisatie

1. Open het dashboard op je eigen telefoon, log in via Magic Link (voer je e-mail in, klik de link in je mailbox).
2. Vink een checklist-item aan.
3. Open hetzelfde dashboard op een ander apparaat (of incognito-venster), log in met een ander gezinslid.
4. Het aangevinkte item moet **direct** (realtime) of na refresh zichtbaar zijn als "Gereed", met "Afgevinkt door [naam]".

## 9. Testen — mobiele Safari (iPhone)

- Test Magic Link-flow specifiek in Safari (niet alleen Chrome) — Apple's
  Mail-app opent links soms in een in-app browser die sessies anders afhandelt.
- Test "Zet op beginscherm" — controleer of login-status bewaard blijft na
  het sluiten en heropenen vanaf het beginscherm-icoon.

## 10. Testen — offline fallback

1. Zet je telefoon in vliegtuigmodus.
2. Vink een item aan — dit moet lokaal blijven werken (badge toont
   "Offline — wijzigingen worden later gesynchroniseerd").
3. Zet wifi/data weer aan — de wijziging moet automatisch naar Supabase
   gestuurd worden (badge toont kort "Synchroniseren..." → "Gesynchroniseerd").

---

## Veiligheidsnotities

- De `anon` key in `sync.js` is voor iedereen op GitHub zichtbaar — dat is
  normaal en veilig zolang RLS actief is. RLS is de echte beveiliging, niet
  het verbergen van de sleutel.
- Zet **nooit** de `service_role`-sleutel, het database-wachtwoord, of andere
  admin-secrets in `sync.js`, `index.html`, of enig bestand dat naar GitHub
  gepusht wordt.
- Checklist-items bevatten bewust geen paspoortnummers, boekingsreferenties
  of andere gevoelige data — alleen generieke taak-labels ("eSIM regelen",
  "Suica instellen"). Dat blijft zo; voeg geen persoonlijke data toe aan
  checklist-tekst.
