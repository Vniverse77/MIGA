<!--
AVUKAT İNCELEMESİ İÇİN TASLAK. Hukuki tavsiye değildir. MIGA kodundan ve belgelerinden (relay/, docs/PROTOCOL.md)
ve kamuya açık ikincil kaynaklardan hazırlandı. [TO BE FILLED BY OWNER: ...] ile işaretli her yer yayından önce
doldurulmalıdır. İngilizce sürüm: PRIVACY.md. Web uygulamasında /privacy sayfasında gösterilir; bu yorum orada görünmez.
-->
# MIGA Gizlilik Politikası ve Aydınlatma Metni

Son güncelleme: [TO BE FILLED BY OWNER: tarih]

MIGA, uçtan uca şifreli bir metin mesajlaşma uygulamasıdır. Sosyal ağ değildir. Bu sayfa, hizmetin neyi
görebildiğini, neyi ne kadar süre sakladığını ve neyi bilemeyeceğini sade bir dille anlatır. Bu metin, 6698
sayılı Kişisel Verilerin Korunması Kanunu (KVKK) madde 10 kapsamındaki aydınlatma metni olarak da hazırlanmıştır.

## 1. MIGA'yı kim işletiyor (veri sorumlusu)

miga.vniverse77.com adresindeki aktarıcı (relay) sunucusu ve web uygulaması, Vniverse77 takma adıyla yayın yapan
bireysel bir geliştirici tarafından işletilir.

- Veri sorumlusu: [TO BE FILLED BY OWNER: yasal ad soyad]
- Adres: [TO BE FILLED BY OWNER: posta adresi]
- Gizlilik başvuruları için iletişim: [TO BE FILLED BY OWNER: e-posta]
- Gerekiyorsa AB veya Türkiye temsilcisi: [TO BE FILLED BY OWNER: ya da "yok"]

MIGA özgür yazılımdır (AGPL-3.0-or-later). Herkes kendi relay'ini çalıştırabilir; bu politika yalnızca yukarıda
adı geçen kişinin işlettiği relay ve web uygulamasını kapsar.

## 2. MIGA'nın toplamadıkları

- Telefon numarası, e-posta, ad ya da hesap yoktur. Kayıt olmazsınız.
- Uygulama içinde analiz, reklam, izleme veya üçüncü taraf isteği yoktur.
- Mesaj içeriği, kişi listesi ve profil adı yalnızca cihazlarınızda, aradaki yolda ise şifreli olarak bulunur.
  Relay bunları açabilecek bir anahtara sahip değildir.

Kimliğiniz cihazınızda üretilen bir anahtar çiftidir. "Adresiniz" açık anahtardır. Gizli anahtarınızı
kaybederseniz kimse, biz dahil, hesabınızı geri getiremez.

## 3. Relay hangi verileri işler

| Veri | Amaç | Ne kadar süre |
|---|---|---|
| Alıcı adresi, gönderen adresi, mesaj kimliği, gönderim zamanı ve şifreli mesaj | Çevrimdışı alıcıya mesajı ulaştırmak | Alıcı teslim aldığını onaylayana, siz mesajı geri çekene ("unsend") ya da 30 güne kadar, hangisi önce olursa |
| Şifreli ek dosya, boyutu, oluşturulma ve bitiş zamanı, silme jetonunun özeti | Alıcının dosyayı indirmesi | En fazla 30 gün ya da silinene kadar |
| Bağlıyken IP adresiniz | Bağlantıyı yürütmek ve kötüye kullanımı sınırlamak (bağlantı ve mesaj hızı sınırları) | Yalnızca relay'in belleğindeki sayaçlarda tutulur, otomatik silinir; diske yazılmaz, relay yazılımı tarafından kaydedilmez (log) |
| Kısa "yazıyor" sinyalleri | Yazma durumunu göstermek | Canlı iletilir, saklanmaz |
| Relay'in teknik hata mesajları | Arızaları gidermek | Mesaj içeriği içermez; sunucu tarafından döndürüldükçe silinir |

Relay, hangi adresin hangi adrese, ne zaman ve ne büyüklükte şifreli veri gönderdiğini görebilir. Mesajın ne
dediğini, bir adresin arkasında kimin olduğunu ya da paylaşmayı seçtiğiniz adı göremez (ad, şifreli mesajın
içinde gider).

Yedekler: sunucu veritabanı her gün yedeklenir ve son 7 yedek saklanır; bu yüzden silinmiş bir mesaj bir yedekte
7 güne kadar daha kalabilir.

## 4. Cloudflare ve barındırma sağlayıcısı

MIGA'ya giden trafik, İstanbul'daki relay sunucusuna ulaşmadan önce Cloudflare'den (içerik dağıtım ve güvenlik
hizmeti) geçer. Cloudflare TLS bağlantısını sonlandırır; bu nedenle IP adresinizi, bağlantı zamanlarını ve trafik
büyüklüğünü görebilir ve kendi politikasına göre kayıt tutabilir (https://www.cloudflare.com/privacypolicy/).
Sunucu sağlayıcısı da teknik kayıt tutabilir. Bunları biz denetleyemeyiz ve hiçbir şey tutmadıklarını
vaat edemeyiz. Mesaj içeriğini okuyamazlar, çünkü içerik cihazınızdan çıkmadan önce şifrelenir.

## 5. Cihazınızdaki veriler

Anahtarınız, kişileriniz, sohbetleriniz, resimleriniz ve ayarlarınız cihazınızda (tarayıcı deposu ya da
uygulama klasörü) saklanır, yüklenmez. Tarayıcı verisini silmek, uygulamayı kaldırmak ya da "Bu cihazı sil"
bunları siler ve geri alınamaz. Başka bir cihazı bağlamak, şifreli bir paketi aynı 30 günlük üst sınırla relay
üzerinden gönderir.

## 6. İşleme amacı ve hukuki sebep

Yalnızca yukarıdaki asgari veriyi, göndermek istediğiniz mesajları iletmek ve hizmeti güvenli ve kötüye
kullanımdan uzak tutmak için işleriz. Hukuki sebepler: hizmetin sunulması (KVKK m. 5/2-c; GDPR m. 6/1-b) ve
hizmetin güvenliği ve düzenli işleyişi için meşru menfaat (KVKK m. 5/2-f; GDPR m. 6/1-f).
[TO BE FILLED BY LAWYER: hukuki sebepleri doğrula.] Veri satmayız, profil çıkarmayız, reklam için kullanmayız.

## 7. Aktarım

Aşağıdakiler dışında kimseye veri vermeyiz: teknik hizmet sağlayıcılar olarak Cloudflare ve sunucu sağlayıcısı;
ve kanunun gerektirdiği durumlarda yetkili makamlar (bölüm 9). Relay İstanbul'dadır; Cloudflare dünya çapında
çalışır, bu nedenle trafik başka ülkelerden geçebilir ve veriler Cloudflare üzerinden yurt dışına aktarılabilir.
Mesajlar cihazınızdan çıkmadan önce şifrelenir. [TO BE FILLED BY LAWYER: KVKK m. 9 mekanizması.]

## 8. Haklarınız

KVKK madde 11 (ve uygulanırsa GDPR) kapsamında: verinizin işlenip işlenmediğini öğrenme, bilgi isteme,
düzeltme veya silme isteme, işlemeye itiraz etme ve veri koruma kurumuna (Türkiye'de Kişisel Verileri Koruma
Kurumu) şikâyet etme haklarınız vardır. Hesap olmadığı için veriyi ancak adresinizi bildirdiğinizde
bulabiliriz; o zaman o adrese ait kuyruktaki mesajları kontrol edip silebiliriz. İçeriği veremeyiz, çünkü
okuyamayız. Bölüm 1'deki iletişime yazın.

## 9. Makam talepleri

Bir makam yasal talepte bulunursa bu, bölüm 1'deki iletişime yazılı olmalıdır. İnceler ve yalnızca kanunun
gerektirdiği kadarını yanıtlarız. Bulunabilecek veriler: son 30 gündeki kuyruktaki mesajların gönderen ve alıcı
adresleri, zamanları ve şifreli metinleri; ek dosya boyutları ve bitiş zamanları. Bulunmayan ve verilemeyecek
veriler: mesaj metni, kişi listeleri, profil adları, bir adresin arkasındaki kimlik ya da relay'deki geçmiş IP
adresleri. Cloudflare ve sunucu sağlayıcısı kendi verilerinden kendileri sorumludur.

## 10. Çocuklar

MIGA 16 yaş ve üzeri içindir. Daha gençseniz kullanmayın. Bir çocuğun kullandığını düşünüyorsanız yukarıdaki
iletişime yazın; belirttiğiniz adresin kuyruktaki verilerini sileriz.

## 11. Güvenlik ve sınırlar

Mesajlar cihazda modern, standart algoritmalarla şifrelenir (bkz.
[docs/PROTOCOL.md](https://github.com/Vniverse77/MIGA/blob/master/docs/PROTOCOL.md)). MIGA erken test
aşamasındadır ve güvenlik denetiminden geçmemiştir. Sürüm 0'da ileri gizlilik (forward secrecy) yoktur: gizli
anahtarınız çalınır ve şifreli mesajlarınız kaydedilmişse okunabilir. Güvenliğinizin buna bağlı olduğu yerlerde
MIGA'ya güvenmeyin. Bir güvenlik sorunu görürseniz
[SECURITY.md](https://github.com/Vniverse77/MIGA/blob/master/SECURITY.md) dosyasına bakın.

## 12. Değişiklikler

Politika değişirse yeni sürüm yeni tarihle burada yayınlanır. Eski sürümler GitHub'daki açık kaynak
geçmişinde kalır.
