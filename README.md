# Emit 250 -lukijasilmulaattori

Windows PowerShell 5.1 -sovellus, joka simuloi Emit 250 -lukijan kortinlukutapahtumia Windowsissa.

## Kaynnistaminen

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

- Parseri tukee 856 tavun tietueisiin perustuvaa `KILP.DAT`-rakennetta. Tiedoston koon on oltava vahintaan kaksi tietuetta ja jaollinen 856:lla.
- `KilpSrj.xml` maarittelee luokkien indeksit. `radat1.xml` maarittelee radat ja leimauslaitteet.
- Luokan ja radan yhdistus voidaan lukea kurssin `ClassShortName`-tiedoista tai erillisista `ClassCourseAssignment`-tiedoista.
- Vaiheen 2 puuttuvalle Emit-numerolle kaytetaan vaiheen 1 Emit-numeroa.
- Simuloidut leimausajat ovat tasaisesti kasvavia testiaikoja, eivat alkuperaisia kilpailutuloksia.
- Valitulla kilpailijalla taytyy olla 1-49 rataan kuuluvaa leimauslaitetta. Lukijakoodi 250 vie yhden paketin paikan.
- COM-portin taytyy olla olemassa Windowsissa ennen lahetysta.

## Projektin tiedostot

- `Emit250Simulator.ps1` - kayttoliittyma, tiedostojen luku ja Emit 250 -sanoman muodostus
- `Start-Emit250Simulator.cmd` - kaynnistys Windowsissa
- `KilpSrj.xml` ja `radat1.xml` - kilpailun luokka- ja ratatiedot
- `KILP.DAT` - kilpailijoiden binaaritiedot; ei kuulu versionhallintaan
- `EMIT.DAT` - valinnainen, aiemman kisan leimaustiedot menneen kisan uusintaa varten; ei kuulu versionhallintaan

