# Emit 250 -lukijasilmulaattori

Windows PowerShell 5.1 -sovellus, joka simuloi Emit 250 -lukijan kortinlukutapahtumia Windowsissa. Samat toiminnot loytyvat myos selaimessa toimivana web-sovelluksena. Mukana on myos erillinen SportIdent-lukijasimulaattori, katso [SportIdent-simulaattori](#sportident-simulaattori) alla.

## Web-sovellus (GitHub Pages)

Sovellus on julkaistu myos selaimessa ajettavana versiona osoitteessa:

**[https://ikivela.github.io/emit250-simulator/](https://ikivela.github.io/emit250-simulator/)**

- Toimii Chromella tai Edgella (Web Serial API -tuki vaaditaan); sivu on tarjolla HTTPS:n yli, joten selainvaatimus tayttyy suoraan.
- Ei vaadi PowerShellia tai asennusta - kaikki toiminta (tiedostojen luku, Emit 250 -sanoman muodostus, COM-porttiin lahetys) tapahtuu selaimessa.
- Kilpailutiedostot (`KILP.DAT`, `KilpSrj.xml`, `radat1.xml`/`radat.xml`, valinnainen `EMIT.DAT`) voi raahata ja pudottaa suoraan sivulle, tai valita **Browse**-painikkeilla.
- Sisaltaa samat toiminnot kuin PowerShell-versio: yksittaisen kilpailijan simulointi, **Simuloi kaikki**, testipaketin tallennus, menneen kisan uusinta EMIT.DAT:sta ja viestikilpailun tuki.
- Sivun lahdekoodi on hakemistossa [`web/`](web/) ja se julkaistaan automaattisesti GitHub Actionsilla ([`.github/workflows/static.yml`](.github/workflows/static.yml)) aina kun `web/`-hakemistoon paivitetaan tiedostoja `main`-haaraan.
- Virtuaalisen COM-portin tarve ja asetukset ovat samat kuin PowerShell-versiossa, katso [Virtuaalinen COM-portti](#virtuaalinen-com-portti) alla.

## PowerShell-sovelluksen kaynnistaminen

Sijoita kilpailun tiedostot samaan hakemistoon ohjelman kanssa:

- `KILP.DAT`
- `KilpSrj.xml`
- `radat1.xml` (yksilokilpailu) tai `radat.xml` (viestikilpailu, katso [Viestikilpailu](#viestikilpailu))
- `EMIT.DAT` (valinnainen, menneen kisan uusintaa varten, katso [Menneen kisan uusinta](#menneen-kisan-uusinta-emitdat))

Kaynnista `Start-Emit250Simulator.cmd`. Jos ensimmaiset kolme tiedostoa loytyvat, ohjelma lataa ne automaattisesti. Tiedostopolut voi vaihtaa kayttoliittyman **Browse...**-painikkeilla.

Vaihtoehtoiset tiedostopolut voi antaa myos komentoriviparametreilla:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File .\Emit250Simulator.ps1 `
    -KilpDat C:\data\KILP.DAT `
    -ClassesXml C:\data\KilpSrj.xml `
    -CoursesXml C:\data\radat1.xml `
    -EmitDat C:\data\EMIT.DAT
```

## Kaytto

1. Valitse kilpailun vaihe (**Race** 1 tai 2) ja paina **Load files**. Viestikilpailussa **Race**-valitsin poistuu automaattisesti kaytosta, katso [Viestikilpailu](#viestikilpailu).
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

## Viestikilpailu

Sovellus tunnistaa viestikilpailun (esim. Jukola/Venla-tyyppinen relay) automaattisesti `KilpSrj.xml`:sta eika vaadi erillista tilan valintaa:

1. Lataa viestin `KILP.DAT`, `KilpSrj.xml` ja viestin ratatiedosto (tyypillisesti `radat.xml`) tavalliseen tapaan. **Race**-valitsin poistuu kaytosta, koska viestissa ei ole vaiheita vaan osuuksia.
2. Kilpailijataulukkoon ilmestyy osuussarake (**Leg** PowerShell-versiossa, **Osuus** web-versiossa): jokainen rivi on yhden joukkueen yhden osuuden juoksija (Numero = joukkuenumero, Osuus = 1-N).
3. Kaikki muut toiminnot (**Simulate card read**, **Simuloi kaikki**, testipaketin tallennus, EMIT.DAT-uusinta) toimivat rivikohtaisesti samalla tavalla kuin yksilokilpailussa.

Viestin `KILP.DAT` on rakenteeltaan eri kuin yksilokilpailun: yksi tietue per joukkue (ei per kilpailija), 138 tavun yhteinen otsikko (joukkuenumero, seura) ja `LegCount` kappaletta 202 tavun osuuslohkoja. Kunkin osuuden lohko sisaltaa juoksijan nimen (`Sukunimi|Etunimi`, UTF-8), osuudelle arvotun radan nimen (esim. `V113`) ja Emit-numeron. Radat luetaan tavalliseen tapaan IOF-muotoisesta ratatiedostosta suoraan osuuden radan nimella, ei luokan kautta.

**Huomio Emit-numeroista:** joissakin viestin `KILP.DAT`-vienneissa uudempien (1 000 000+) Emit-korttien numero on tallennettu 1 000 000 pienempana (vanha 6-numeroinen kenttarajoitus). Yksittaisen kilpailijan simulointi lahettaa `KILP.DAT`:sta luetun numeron sellaisenaan. EMIT.DAT-uusinnassa sovellus kokeilee molempia (luettu numero ja luettu numero + 1 000 000) ja kayttaa uusinnassa aina EMIT.DAT:sta luettua, todellista korttinumeroa.

## Tiedostomuoto ja rajaukset

- Yksilokilpailun parseri tukee `KILP.DAT`-tietueita, joissa on 360 tavun yhteinen otsikko ja 248 tavua per kilpailun vaihe: 608 tavun tietueita yhden vaiheen kilpailulle, 856 tavun tietueita kun kilpailussa on kaksi vaihetta (Race 1 ja Race 2). Tietuekoko tunnistetaan automaattisesti tiedoston koosta.
- Viestikilpailun `KILP.DAT`-tietuekoko on 138 + 202 x osuuksien maara, tunnistetaan `KilpSrj.xml`:n `Software/FileFormat/Legs`-arvosta (katso [Viestikilpailu](#viestikilpailu) yla).
- `KilpSrj.xml` maarittelee luokkien indeksit (ja viestissa osuuksien maaran). Ratatiedosto (`radat1.xml` yksilokilpailussa, tyypillisesti `radat.xml` viestissa) maarittelee radat ja leimauslaitteet.
- Luokan ja radan yhdistys voidaan lukea kurssin `ClassShortName`-tiedoista tai erillisista `ClassCourseAssignment`-tiedoista (yksilokilpailu); viestissa osuuden rata luetaan suoraan `KILP.DAT`:sta.
- Vaiheen 2 puuttuvalle Emit-numerolle kaytetaan vaiheen 1 Emit-numeroa. Jos tiedostossa on vain yksi vaihe, Race 2 -valinta antaa selkean virheen.
- Tavallisessa simuloinnissa leimausajat ovat tasaisesti kasvavia testiaikoja, eivat alkuperaisia kilpailutuloksia. Menneen kisan uusinnassa (katso yllaolevalta) leimausajat luetaan sen sijaan aidosta `EMIT.DAT`-tiedostosta.
- Emit-numeron taytyy olla valilla 1-16 777 215 (paketin 3 tavun kentan koko). Valitulla kilpailijalla taytyy olla 1-49 rataan kuuluvaa leimauslaitetta. Lukijakoodi 250 vie yhden paketin paikan.
- COM-portin taytyy olla olemassa (PowerShell-versio Windowsissa, web-versio kayttojarjestelman COM-porttilistalla) ennen lahetysta.

## SportIdent-simulaattori

Web-sovelluksen rinnalla on erillinen sivu [`web/sportident.html`](web/sportident.html), joka simuloi SportIdent-lukijaasemaa (BSM8, EXT-protokolla, 38400 baudia) Web Serial -yhteydella. Toisin kuin Emit 250 -simulaattori (joka vain lahettaa yksisuuntaisen 217 tavun paketin), SportIdent-simulaattori esiintyy aidosti asemana sarjaportissa: se lahettaa "kortti asetettu" -ilmoituksen ja vastaa Pirilan ohjelman lohkokyselyihin, joten se testaa koko lukuketjun (`lue_SI`/`tulkSI` Pirilan lahdekoodissa).

Sivu kayttaa samoja kilpailutiedostoja (`KILP.DAT`, `KilpSrj.xml`, `radat1.xml`/`radat.xml`) ja sama kilpailijan kortti-/Emit-numero KILP.DAT:sta toimii myos SI-kortin sarjanumerona. Tuettuja korttisukupolvia: SI5, SI6, SI9, SI8, pCard, tCard ja SI10/11 - joko automaattisesti kortin numeroalueen perusteella (samat rajat kuin Pirilan omassa koodissa) tai pakotettuna valikosta. Tarkoitettu ensisijaisesti [Pirilan SportIdent-tuen](https://github.com/PirilaTP/tulospalvelu/tree/feature/sportident-reader) testaamiseen kehityksen aikana; katso sivun oma ohjeosio lisatietoja varten. Tama on ensimmainen versio: EMIT.DAT-uusinta ei viela ole tuettu SportIdent-simulaattorissa (vain Emit 250 -simulaattorissa).

## Projektin tiedostot

- `Emit250Simulator.ps1` - PowerShell-kayttoliittyma, tiedostojen luku ja Emit 250 -sanoman muodostus
- `Start-Emit250Simulator.cmd` - kaynnistys Windowsissa
- `web/` - selaimessa toimivat versiot ([index.html](web/index.html)/[app.js](web/app.js) Emit 250:lle, [sportident.html](web/sportident.html)/[sportident.js](web/sportident.js) SportIdentille), julkaistu GitHub Pagesiin osoitteessa [ikivela.github.io/emit250-simulator](https://ikivela.github.io/emit250-simulator/)
- `.github/workflows/static.yml` - GitHub Actions -tyonkulku, joka julkaisee `web/`-hakemiston GitHub Pagesiin
- `KilpSrj.xml` ja `radat1.xml`/`radat.xml` - kilpailun luokka- ja ratatiedot (`radat.xml` viestikilpailussa)
- `KILP.DAT` - kilpailijoiden (tai viestissa joukkueiden) binaaritiedot; ei kuulu versionhallintaan
- `EMIT.DAT` - valinnainen, aiemman kisan leimaustiedot menneen kisan uusintaa varten; ei kuulu versionhallintaan

