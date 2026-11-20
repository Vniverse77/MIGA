<!--
AVUKAT İNCELEMESİ İÇİN TASLAK. Hukuki tavsiye değildir. MIGA kodundan ve belgelerinden (relay/, docs/PROTOCOL.md),
2026-11-20 tarihli üretim sunucusu kontrolünden ve kamuya açık ikincil kaynaklardan hazırlandı.
[TO BE FILLED BY OWNER: ...] ile işaretli her yer yayından önce doldurulmalıdır.
İngilizce sürüm: PRIVACY.md. KVKK aydınlatma metni: KVKK.tr.md. /privacy sayfasında gösterilir; bu yorum görünmez.
-->
# MIGA Gizlilik Politikası

Son güncelleme: [TO BE FILLED BY OWNER: tarih]

> **Kısaca**
> Hesap yok, telefon numarası yok, e-posta yok, reklam yok, analitik yok ve verilerin satılmaz. Aktarıcı (relay)
> mesajlarını okuyamaz. Ancak bağlıyken IP adresini görür (yalnızca bellekte, hiçbir kayda yazılmaz) ve hangi adresin
> hangi adrese, ne zaman ve ne büyüklükte mesaj gönderdiğini öğrenir. MIGA gizlidir ama anonim değildir.

## 1. MIGA'yı kim işletiyor (veri sorumlusu)

miga.vniverse77.com adresindeki aktarıcı sunucusu ve web uygulaması, Vniverse77 takma adıyla yayın yapan bireysel
bir geliştirici tarafından işletilir. Bu kişi hizmetin veri sorumlusudur.

- Veri sorumlusu: [TO BE FILLED BY OWNER: yasal ad soyad]
- Adres: [TO BE FILLED BY OWNER: posta adresi]
- Gizlilik başvuruları için iletişim: [TO BE FILLED BY OWNER: e-posta adresi]
- Gerekiyorsa AB veya Türkiye temsilcisi: [TO BE FILLED BY OWNER: ya da "yok"]

MIGA özgür yazılımdır (AGPL-3.0-or-later). Herkes kendi aktarıcısını çalıştırabilir; bu politika yalnızca yukarıda
adı geçen kişinin işlettiği aktarıcıyı ve web uygulamasını kapsar. KVKK madde 10 aydınlatma metni
[KVKK sayfasındadır](/kvkk).

## 2. MIGA'nın toplamadıkları

- Telefon numarası, e-posta adresi, ad veya hesap yok. Kayıt olmazsın.
- Uygulama içinde analitik, reklam, takip çerezi veya üçüncü taraf isteği yok.
- Mesaj içeriği, kişi listesi ve profil adı yok: bunlar yalnızca cihazlarında, aralarında ise şifreli olarak bulunur.
  Aktarıcıda bunları açabilecek anahtar yoktur.

Kimliğin, cihazında üretilen bir anahtar çiftidir. "Adresin" açık anahtardır. Gizli anahtarı kaybedersen kimse,
biz dahil, hesabını kurtaramaz.

## 3. Ne saklanır, nerede ve ne kadar süre

| Veri | Neden | Nerede | Ne kadar |
|---|---|---|---|
| Alıcı adresi, gönderen adresi, mesaj kimliği, gönderim zamanı ve şifreli mesaj | Çevrimdışı alıcıya mesajı ulaştırmak | İstanbul'daki aktarıcı veritabanı (disk) | Alıcı aldığını onaylayana, sen mesajı geri alana ("unsend") ya da 30 güne kadar, hangisi önce olursa. Alıcı başına en fazla 1000 bekleyen mesaj |
| Şifreli ek dosyası, boyutu, oluşturma ve bitiş zamanı, silme anahtarının özeti | Alıcının dosyayı indirmesi | Aktarıcı diski | En fazla 30 gün veya silinene kadar |
| Günlük veritabanı yedekleri | Arıza sonrası kurtarma | Sunucu diski | Son 7 yedek tutulur; silinen bir mesaj yedekte 7 gün daha kalabilir |
| Aktarıcının teknik hata mesajları | Arızaları gidermek | Sunucu günlük dosyası | Mesaj içeriği ve istemci IP adresi içermez; yalnızca başlatma ve hata satırları |

Silinen kayıtlar veritabanından çıkarılır, ancak baytları üzerine yazılana kadar boş veritabanı sayfalarında
kalabilir. Sunucuda sana ait başka hiçbir şey saklanmaz: kullanıcı tablosu, oturum veya cihaz listesi yoktur.

## 4. Yalnızca bellekte işlenenler

| Veri | Neden | Ne kadar |
|---|---|---|
| Bağlıyken IP adresin (Cloudflare'in eklediği başlıktan alınır) | Bağlantıyı yürütmek ve kötüye kullanımı sınırlamak: IP başına bağlantı ve mesaj hız sınırları | Aktarıcının belleğinde kısa bir pencere boyunca sayaç olarak tutulur, kendiliğinden düşer. Diske yazılmaz, aktarıcı yazılımı tarafından kaydedilmez, veritabanında ve yedeklerde yoktur |
| Kısa "yazıyor" sinyalleri | Yazmakta olduğunu göstermek | Canlı iletilir, saklanmaz |

Aktarıcı yazılımının erişim kaydı (access log) yoktur. Sunucudaki tünel yazılımı (Cloudflare Tunnel) yalnızca
kendi Cloudflare bağlantı olaylarını kaydeder, ziyaretçi adreslerini kaydetmez; araya giren başka bir web sunucusu
veya vekil sunucu da yoktur.

## 5. Anonim OLMAYAN şeyler

MIGA'nın verdiğinden fazla gizlilik varsaymayın:

- **IP adresin görünür:** MIGA'yı kullanırken Cloudflare görür, aktarıcı ise bellekte görür (bölüm 4). İnternet
  sağlayıcın ve ağın da miga.vniverse77.com'a bağlandığını görebilir. Bu önemliyse VPN veya Tor kullan; MIGA bunu
  gizlemez.
- **Üst veriyi (metadata) aktarıcı görür:** hangi adres hangi adrese, ne zaman ve ne büyüklükte şifreli veri gönderdi.
  Metni, paylaşmayı seçtiğin adı ve bir adresin arkasındaki kişiyi göremez.
- **Adresler sabit tanımlayıcıdır.** Adresini bilen herkes sana mesaj gönderebilir. İstenmeyen gönderenler için
  uygulamadaki "engelle" seçeneğini kullan.
- Kilidi açık cihazını ya da gizli anahtarını ele geçiren kişi sohbetlerini okuyabilir.
- Metin şifreli olsa da mesaj boyutu ve zamanlaması örüntüler ele verebilir.

## 6. Cloudflare ve barındırma sağlayıcısı

MIGA trafiği, İstanbul'daki aktarıcı sunucuya ulaşmadan önce Cloudflare'den (içerik dağıtım ve güvenlik hizmeti)
geçer. Cloudflare bizim adımıza hizmet sağlayıcı (veri işleyen) olarak çalışır: TLS bağlantısını sonlandırır, bu
yüzden IP adresini, bağlantı zamanlarını ve trafik boyutunu görebilir; kendi kayıt ve saklama kurallarını kendi
politikasına göre uygular (https://www.cloudflare.com/privacypolicy/). Bunları biz denetleyemeyiz. Sunucu barındırıcısı
da teknik kayıt tutabilir; hiçbir şey tutmadıklarını vaat edemeyiz. Hiçbiri mesaj içeriğini okuyamaz, çünkü içerik
gönderilmeden önce cihazında şifrelenir.

## 7. Cihazındaki veriler

Anahtarın, kişilerin, sohbetlerin, resimlerin ve ayarların cihazında (tarayıcı depolaması veya uygulama veri klasörü)
durur ve yüklenmez. Tarayıcı verisini temizlemek, uygulamayı kaldırmak veya "Bu cihazı sil" seçeneği bunları siler ve
geri alınamaz. Başka bir cihazı bağlamak, aynı 30 günlük üst sınırla aktarıcı üzerinden şifreli bir paket gönderir.

## 8. İşleme amacı ve hukuki sebep

Yukarıdaki asgari veriyi, göndermek istediğin mesajları iletmek ve hizmeti erişilebilir ve kötüye kullanımdan uzak
tutmak için işleriz. Hukuki sebepler: kullandığın hizmetin ifası ve hizmetin güvenliği ile istikrarlı çalışmasındaki
meşru menfaatimiz (KVKK m. 5/2-c ve 5/2-f; GDPR m. 6/1-b ve 6/1-f).
[TO BE FILLED BY LAWYER: hukuki sebepleri doğrula.] Veri satmayız, kullanıcıları profillemeyiz, reklam için
kullanmayız. Kanun ileride trafik kaydı tutmamızı gerektirirse, kayıt başlamadan önce bu politika değiştirilir.

## 9. Paylaşım ve aktarım

Burada sayılanlar dışında kimseye veri vermeyiz: teknik hizmet sağlayıcı olarak Cloudflare ve sunucu barındırıcısı;
ve kanunun gerektirdiği hâllerde yetkili makamlar (bölüm 11). Aktarıcı İstanbul'dadır; Cloudflare dünya çapında
çalışır, bu nedenle yoldaki veri, IP adresin dahil, başka ülkelerde işlenebilir. Türk hukukunda bu yurt dışına aktarımdır
(KVKK m. 9); [KVKK sayfasına](/kvkk) bak. Mesajlar cihazından çıkmadan önce şifrelenir.

## 10. Haklarınız

GDPR veya KVKK (6698 sayılı Kanun) uygulanıyorsa; hakkında veri işlenip işlenmediğini sorabilir, erişim, düzeltme veya
silme isteyebilir, işlemeye itiraz edebilir, rızanı geri çekebilir ve veri koruma otoritene (Türkiye'de Kişisel
Verileri Koruma Kurumu, https://www.kvkk.gov.tr) şikâyet edebilirsin. Hesap olmadığı için veriyi ancak adresini
bildirirsen bulabiliriz. O zaman o adrese bekleyen mesaj olup olmadığına bakıp silebiliriz. Mesaj içeriğini
veremeyiz, çünkü okuyamıyoruz. Bölüm 1'deki iletişime yaz. Ücretsizdir ve 30 gün içinde yanıtlarız.

## 11. Makam talepleri

Bir makam yasal talep gönderirse, bu talep bölüm 1'deki iletişime yazılı olmalıdır. İnceler ve yalnızca kanunun
gerektirdiği kadarını yanıtlarız. Bulunabilecekler: son 30 günde bekleyen mesajların gönderen ve alıcı adresleri,
zamanları ve şifreli metni; ek dosyası boyutları ve bitiş zamanları. Bulunmayan ve verilemeyenler: mesaj düz metni,
kişi listeleri, profil adları, bir adresin arkasındaki kimlik veya aktarıcıdan geçmiş IP adresleri (kaydedilmez).
Cloudflare ve barındırıcı kendi verilerinden kendileri sorumludur. Arka kapı eklemeyiz, şifrelemeyi zayıflatmayız.

## 12. Çocuklar

MIGA 16 yaş ve üzeri içindir. Daha gençsen kullanma. Bir çocuğun kullandığını düşünüyorsan yukarıdaki iletişime yaz;
belirttiğin adresin bekleyen verilerini sileriz.

## 13. Güvenlik ve sınırlar

Mesajlar cihazda modern, standart algoritmalarla şifrelenir (bkz.
[docs/PROTOCOL.md](https://github.com/Vniverse77/MIGA/blob/master/docs/PROTOCOL.md)). Aktarıcı ve web uygulaması açık
kaynaktır, ne yaptıklarını kontrol edebilirsin. MIGA erken test aşamasındadır ve güvenlik denetiminden geçmemiştir.
Sürüm 0'da ileriye dönük gizlilik (forward secrecy) yoktur: gizli anahtarın çalınır ve şifreli mesajların kaydedilmişse
okunabilir. Bazı ülkelerde mesajlaşma uygulamaları engellidir ve kullanmak cezalandırılabilir. Güvenliğin buna bağlıysa
MIGA'ya güvenme. Seni riske atan bir ihlal olursa, kanunun gerektirdiği şekilde sana ve otoriteye bildiririz. Güvenlik
sorunu bildirmek için [SECURITY.md](https://github.com/Vniverse77/MIGA/blob/master/SECURITY.md).

## 14. Değişiklikler

Politika değişirse yeni sürüm burada yeni tarihle yayımlanır. Eski sürümler GitHub'daki açık kaynak geçmişinde kalır.
