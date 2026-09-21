# Emit 250 -lukijasilmulaattori

Windows PowerShell 5.1 -sovellus, joka simuloi Emit 250 -lukijan kortinlukutapahtumia Windowsissa. Samat toiminnot loytyvat myos selaimessa toimivana web-sovelluksena.

## Web-sovellus (GitHub Pages)

Sovellus on julkaistu myos selaimessa ajettavana versiona osoitteessa:

**[https://ikivela.github.io/emit250-simulator/](https://ikivela.github.io/emit250-simulator/)**

- Toimii Chromella tai Edgella (Web Serial API -tuki vaaditaan); sivu on tarjolla HTTPS:n yli, joten selainvaatimus tayttyy suoraan.
- Ei vaadi PowerShellia tai asennusta - kaikki toiminta (tiedostojen luku, Emit 250 -sanoman muodostus, COM-porttiin lahetys) tapahtuu selaimessa.
- Kilpailutiedostot (`KILP.DAT`, `KilpSrj.xml`, `radat1.xml`, valinnainen `EMIT.DAT`) voi raahata ja pudottaa suoraan sivulle, tai valita **Browse**-painikkeilla.
- Sisaltaa samat toiminnot kuin PowerShell-versio: yksittaisen kilpailijan simulointi, **Simuloi kaikki**, testipaketin tallennus ja menneen kisan uusinta EMIT.DAT:sta.
- Sivun lahdekoodi on hakemistossa [`web/`](web/) ja se julkaistaan automaattisesti GitHub Actionsilla ([`.github/workflows/static.yml`](.github/workflows/static.yml)) aina kun `web/`-hakemistoon paivitetaan tiedostoja `main`-haaraan.
- Virtuaalisen COM-portin tarve ja asetukset ovat samat kuin PowerShell-versiossa, katso [Virtuaalinen COM-portti](#virtuaalinen-com-portti) alla.

## PowerShell-sovelluksen kaynnistaminen

Sijoita kilpailun tiedostot samaan hakemistoon ohjelman kanssa:

- `KILP.DAT`
- `KilpSrj.xml`
- `radat1.xml`

Kaynnista `Start-Emit250Simulator.cmd`. Jos kaikki kolme tiedostoa loytyvat, ohjelma lataa ne automaattisesti. Tiedostopolut voi vaihtaa kayttoliittyman **Browse...**-painikkeilla.

Vaihtoehtoiset tiedostopolut voi antaa myos komentoriviparametreilla:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File .\Emit250Simulator.ps1 `
    -KilpDat C:\data\KILP.DAT `
    -ClassesXml C:\data\KilpSrj.xml `
    -CoursesXml C:\data\radat1.xml `
    -EmitDat C:\data\EMIT.DAT
```

## Kaytto

1. Valitse kilpailun vaihe (**Race** 1 tai 2) ja paina **Load files**.
2. Hae kilpailijaa numerolla, nimella, sarjalla, radalla, Emit-numerolla tai seuralla.
3. Valitse kilpailija taulukosta.
4. Paivita COM-portit **Refresh**-painikkeella ja valitse simulaattorin portti.
5. Anna simuloitu loppuaika minuutteina.
6. Paina **Simulate card read**.

Ohjelma muodostaa kilpailijan radan perusteella leimat, jakaa leimausajat tasaisesti annetulle kokonaisajalle, lisaa lukijakoodin 250 ja lahettaa 217 tavun Emit 250 -sanoman. Sanoma validoidaan ennen lahetysta.

## Virtuaalinen COM-portti

Jos vastaanottava tulospalveluohjelma odottaa fyysista COM-porttia, tarvitaan virtuaalinen porttipari, esimerkiksi:

```text
Simulaattori -> COM10
                                virtuaalinen pari
Tulospalvelu <- COM11
```

Valitse simulaattorissa COM10 ja tulospalveluohjelmassa COM11.

Sarjaporttiasetukset ovat:

```text
9600 baudia, 8 databittia, ei pariteettia, 2 stop-bittia
```

**Send packet twice** on oletuksena valittuna, koska vastaanottava ohjelma voi odottaa kahta identtista lukusanomaa ennen tapahtuman hyvaksymista.

## Testipaketin tallentaminen

**Save packet...** tallentaa validoidun 217 tavun binaarisanoman `.bin`-tiedostoon lahettamatta sita COM-porttiin. Tata voi kayttaa vastaanottavan ohjelman tai protokollan testaamiseen.

## Menneen kisan uusinta (EMIT.DAT)

**Race replay (EMIT.DAT)** -osiolla voi toistaa aiemmin ajetun kisan aidoilla leimausajoilla sen sijaan etta ne keksitaan.

1. Lataa kilpailun `KILP.DAT`, `KilpSrj.xml` ja `radat1.xml` tavalliseen tapaan.
2. Valitse kyseisen kisan alkuperainen `EMIT.DAT`-leimaustiedosto ja paina **Load EMIT.DAT**. Tila kertoo, kuinka moni EMIT.DAT:n leimaus yhdistyi ladattuihin kilpailijoihin Emit-numeron perusteella.
3. Valitse COM-portti, anna **Replay duration (min)** (koko uusinnan kokonaiskesto) ja paina **Start replay**.

Kilpailijat lahetetaan maaliintuloaikojen mukaisessa jarjestyksessa, ja lahetysten valit skaalataan suhteessa alkuperaisiin valeihin niin, etta koko kisa mahtuu annettuun kestoon - jarjestys ja suhteelliset valit pysyvat aitoina. Jokaisen paketin rastikoodit ja leimausajat ovat EMIT.DAT:sta luettuja oikeita arvoja, ei tasavalisia keksittyja aikoja. **Stop replay** keskeyttaa toiston.

EMIT.DAT on kiintomittaisia 188 tavun tietueita: Emit-numero (UInt32) offsetissa 4 ja jopa 48 leimausvalia sekunteina (UInt16, nollilla taytetty) offsetissa 0x48. Leimausten rastikoodit haetaan kilpailijan radalta samalla tavalla kuin muutenkin; jos kilpailijalla ja EMIT.DAT-tietueella on eri maara leimauksia, kaytetaan lyhyempaa maaraa.

## Tiedostomuoto ja rajaukset

- Parseri tukee `KILP.DAT`-tietueita, joissa on 360 tavun yhteinen otsikko ja 248 tavua per kilpailun vaihe: 608 tavun tietueita yhden vaiheen kilpailulle, 856 tavun tietueita kun kilpailussa on kaksi vaihetta (Race 1 ja Race 2). Tietuekoko tunnistetaan automaattisesti tiedoston koosta.
- `KilpSrj.xml` maarittelee luokkien indeksit. `radat1.xml` maarittelee radat ja leimauslaitteet.
- Luokan ja radan yhdistys voidaan lukea kurssin `ClassShortName`-tiedoista tai erillisista `ClassCourseAssignment`-tiedoista.
- Vaiheen 2 puuttuvalle Emit-numerolle kaytetaan vaiheen 1 Emit-numeroa. Jos tiedostossa on vain yksi vaihe, Race 2 -valinta antaa selkean virheen.
- Tavallisessa simuloinnissa leimausajat ovat tasaisesti kasvavia testiaikoja, eivat alkuperaisia kilpailutuloksia. Menneen kisan uusinnassa (katso yllaolevalta) leimausajat luetaan sen sijaan aidosta `EMIT.DAT`-tiedostosta.
- Valitulla kilpailijalla taytyy olla 1-49 rataan kuuluvaa leimauslaitetta. Lukijakoodi 250 vie yhden paketin paikan.
- COM-portin taytyy olla olemassa (PowerShell-versio Windowsissa, web-versio kayttojarjestelman COM-porttilistalla) ennen lahetysta.

## Projektin tiedostot

- `Emit250Simulator.ps1` - PowerShell-kayttoliittyma, tiedostojen luku ja Emit 250 -sanoman muodostus
- `Start-Emit250Simulator.cmd` - kaynnistys Windowsissa
- `web/` - selaimessa toimiva versio ([index.html](web/index.html), [app.js](web/app.js)), julkaistu GitHub Pagesiin osoitteessa [ikivela.github.io/emit250-simulator](https://ikivela.github.io/emit250-simulator/)
- `.github/workflows/static.yml` - GitHub Actions -tyonkulku, joka julkaisee `web/`-hakemiston GitHub Pagesiin
- `KilpSrj.xml` ja `radat1.xml` - kilpailun luokka- ja ratatiedot
- `KILP.DAT` - kilpailijoiden binaaritiedot; ei kuulu versionhallintaan
- `EMIT.DAT` - valinnainen, aiemman kisan leimaustiedot menneen kisan uusintaa varten; ei kuulu versionhallintaan

