// Interface translations. English is the source; every other language must have the same keys.
// The choice is stored in this browser only and never sent anywhere.

const en = {
	language: 'Language',

	// Landing page
	nav_app: 'Open app',
	nav_source: 'Source',
	badge: 'Encrypted · No account · Test phase',
	lead: 'A messenger built to keep people connected across restricted networks. No phone number, no e-mail: your identity is a key that never leaves your device.',
	cta_open: 'Open MIGA in your browser',
	cta_code: 'Read the code',
	flow_1: "Your device seals the message with the recipient's key.",
	flow_2: 'A relay passes the sealed envelope along over plain HTTPS.',
	flow_3: "Only the recipient's device can open it.",
	flow_note: 'The relay sees an envelope, never the letter.',
	how_title: 'How it works',
	how_lead: 'Three ideas, kept simple on purpose.',
	f1_title: 'End-to-end encrypted',
	f1_text: 'Messages are encrypted on your device. The relay only forwards sealed envelopes.',
	f2_title: 'Looks like ordinary web traffic',
	f2_text: 'Everything travels over standard HTTPS on port 443, like any other website.',
	f3_title: 'No central account',
	f3_text: 'The relay is replaceable. Anyone can run one, and your key works with all of them.',
	part_title: 'Part of Vniverse77',
	part_lead: 'MIGA is built in the open alongside the rest of the Vniverse77 projects.',
	forum_text: 'Questions, feedback and test reports. Tell us what works from your network.',
	site_text: 'Videos, blog posts and the other projects behind MIGA.',
	warning:
		'MIGA is experimental and has not been security-audited. Do not rely on it yet where your safety depends on it.',

	// App
	status_online: 'online',
	status_offline: 'offline',
	status_connecting: 'connecting',
	your_address: 'Your address',
	copy_address: 'Copy address',
	backup_key: 'Back up key',
	restore: 'Restore',
	new_conversation: 'New conversation',
	ph_address: 'Their MIGA address',
	ph_name: 'Name (only you see it)',
	start_chat: 'Start chat',
	no_conversations: 'No conversations yet. Share your address with someone to begin.',
	back: 'Back',
	no_messages: 'No messages yet. Messages are encrypted before they leave this device.',
	ph_message: 'Write a message',
	send: 'Send',
	pick: "Pick a conversation, or start one with someone's MIGA address.",
	state_pending: 'waiting to send',
	state_sent: 'sent',
	state_failed: 'not sent',
	name_unknown: 'Unknown',
	name_contact: 'Contact',
	n_relay_rejected: 'The relay rejected a message: {code}',
	n_too_long: 'That message is too long (limit: {max} characters).',
	n_bad_address: 'That is not a valid MIGA address (64 letters and digits).',
	n_own_address: 'That is your own address.',
	n_copied: 'Your address was copied.',
	n_copy_failed: 'Could not copy. Select the address and copy it by hand.',
	q_backup: 'Your secret key gives full access to your identity. Copy it to the clipboard?',
	n_key_copied: 'Secret key copied. Store it somewhere safe and clear your clipboard.',
	n_key_copy_failed: 'Could not copy the key.',
	q_restore_prompt: 'Paste the secret key to restore (64 characters):',
	n_bad_key: 'That is not a valid secret key.',
	q_restore_confirm: 'This replaces the identity stored in this browser. Continue?'
};

export type MessageKey = keyof typeof en;
type Dictionary = Record<MessageKey, string>;

const tr: Dictionary = {
	language: 'Dil',

	nav_app: 'Uygulamayı aç',
	nav_source: 'Kaynak kod',
	badge: 'Şifreli · Hesap yok · Test aşaması',
	lead: 'Kısıtlı ağlarda insanların iletişimde kalması için yapılmış bir mesajlaşma uygulaması. Telefon numarası yok, e-posta yok: kimliğiniz, cihazınızdan hiç çıkmayan bir anahtardır.',
	cta_open: "MIGA'yı tarayıcıda aç",
	cta_code: 'Kodu incele',
	flow_1: 'Cihazınız mesajı alıcının anahtarıyla mühürler.',
	flow_2: 'Bir aktarıcı, mühürlü zarfı sıradan HTTPS üzerinden iletir.',
	flow_3: 'Zarfı yalnızca alıcının cihazı açabilir.',
	flow_note: 'Aktarıcı zarfı görür, mektubu asla görmez.',
	how_title: 'Nasıl çalışır',
	how_lead: 'Üç fikir, bilerek sade tutuldu.',
	f1_title: 'Uçtan uca şifreli',
	f1_text: 'Mesajlar cihazınızda şifrelenir. Aktarıcı yalnızca mühürlü zarfları iletir.',
	f2_title: 'Sıradan web trafiği gibi görünür',
	f2_text: 'Her şey, herhangi bir web sitesi gibi 443 numaralı porttan standart HTTPS ile gider.',
	f3_title: 'Merkezi hesap yok',
	f3_text:
		'Aktarıcı değiştirilebilir. İsteyen herkes bir tane çalıştırabilir, anahtarınız hepsiyle çalışır.',
	part_title: "Vniverse77'nin bir parçası",
	part_lead: 'MIGA, diğer Vniverse77 projeleriyle birlikte açık olarak geliştiriliyor.',
	forum_text: 'Sorular, geri bildirim ve test raporları. Kendi ağınızda neyin çalıştığını bize yazın.',
	site_text: "Videolar, blog yazıları ve MIGA'nın arkasındaki diğer projeler.",
	warning:
		'MIGA deneyseldir ve güvenlik denetiminden geçmemiştir. Güvenliğinizin ona bağlı olduğu durumlarda henüz ona güvenmeyin.',

	status_online: 'çevrimiçi',
	status_offline: 'çevrimdışı',
	status_connecting: 'bağlanıyor',
	your_address: 'Adresiniz',
	copy_address: 'Adresi kopyala',
	backup_key: 'Anahtarı yedekle',
	restore: 'Geri yükle',
	new_conversation: 'Yeni sohbet',
	ph_address: 'Karşı tarafın MIGA adresi',
	ph_name: 'İsim (yalnızca siz görürsünüz)',
	start_chat: 'Sohbeti başlat',
	no_conversations: 'Henüz sohbet yok. Başlamak için adresinizi biriyle paylaşın.',
	back: 'Geri',
	no_messages: 'Henüz mesaj yok. Mesajlar bu cihazdan çıkmadan önce şifrelenir.',
	ph_message: 'Mesaj yazın',
	send: 'Gönder',
	pick: 'Bir sohbet seçin ya da birinin MIGA adresiyle yeni bir sohbet başlatın.',
	state_pending: 'gönderilmeyi bekliyor',
	state_sent: 'gönderildi',
	state_failed: 'gönderilemedi',
	name_unknown: 'Bilinmeyen',
	name_contact: 'Kişi',
	n_relay_rejected: 'Aktarıcı bir mesajı reddetti: {code}',
	n_too_long: 'Bu mesaj çok uzun (sınır: {max} karakter).',
	n_bad_address: 'Bu geçerli bir MIGA adresi değil (64 harf ve rakam).',
	n_own_address: 'Bu sizin kendi adresiniz.',
	n_copied: 'Adresiniz kopyalandı.',
	n_copy_failed: 'Kopyalanamadı. Adresi seçip elle kopyalayın.',
	q_backup: 'Gizli anahtarınız kimliğinize tam erişim verir. Panoya kopyalansın mı?',
	n_key_copied: 'Gizli anahtar kopyalandı. Güvenli bir yerde saklayın ve panonuzu temizleyin.',
	n_key_copy_failed: 'Anahtar kopyalanamadı.',
	q_restore_prompt: 'Geri yüklenecek gizli anahtarı yapıştırın (64 karakter):',
	n_bad_key: 'Bu geçerli bir gizli anahtar değil.',
	q_restore_confirm: 'Bu işlem, bu tarayıcıda kayıtlı kimliğin yerine geçer. Devam edilsin mi?'
};

// Turkmen: first draft, to be reviewed by a native speaker.
const tk: Dictionary = {
	language: 'Dil',

	nav_app: 'Programmany aç',
	nav_source: 'Çeşme kody',
	badge: 'Şifrlenen · Hasapsyz · Synag tapgyry',
	lead: 'Çäklendirilen torlarda adamlaryň aragatnaşykda galmagy üçin döredilen messenjer. Telefon belgisi ýok, e-poçta ýok: şahsyýetiňiz enjamyňyzdan hiç haçan çykmaýan açardyr.',
	cta_open: 'MIGA-ny brauzerde aç',
	cta_code: 'Kody oka',
	flow_1: 'Enjamyňyz haty alyjynyň açary bilen möhürleýär.',
	flow_2: 'Relaý möhürlenen bukjany adaty HTTPS arkaly geçirýär.',
	flow_3: 'Ony diňe alyjynyň enjamy açyp bilýär.',
	flow_note: 'Relaý bukjany görýär, haty hiç haçan görmeýär.',
	how_title: 'Nähili işleýär',
	how_lead: 'Üç pikir, bilgeşleýin ýönekeý saklandy.',
	f1_title: 'Uçdan-uja şifrlenen',
	f1_text: 'Hatlar siziň enjamyňyzda şifrlenýär. Relaý diňe möhürlenen bukjalary geçirýär.',
	f2_title: 'Adaty web traffigi ýaly görünýär',
	f2_text: 'Hemme zat islendik web sahypasy ýaly, 443-nji portda adaty HTTPS arkaly gidýär.',
	f3_title: 'Merkezi hasap ýok',
	f3_text:
		'Relaýy çalşyp bolýar. Ony islendik adam işledip bilýär, açaryňyz bolsa olaryň hemmesi bilen işleýär.',
	part_title: 'Vniverse77-niň bir bölegi',
	part_lead: 'MIGA beýleki Vniverse77 taslamalary bilen bilelikde açyk görnüşde döredilýär.',
	forum_text:
		'Soraglar, teswirler we synag hasabatlary. Öz toruňyzda nämäniň işleýändigini bize ýazyň.',
	site_text: 'Wideolar, blog ýazgylary we MIGA-nyň arkasyndaky beýleki taslamalar.',
	warning:
		'MIGA synag tapgyrynda we howpsuzlyk barlagyndan geçmedi. Howpsuzlygyňyz oňa bagly bolan ýagdaýlarda entek oňa bil baglamaň.',

	status_online: 'onlaýn',
	status_offline: 'oflaýn',
	status_connecting: 'birikdirilýär',
	your_address: 'Siziň salgyňyz',
	copy_address: 'Salgyny göçür',
	backup_key: 'Açary ätiýaçla',
	restore: 'Dikelt',
	new_conversation: 'Täze söhbetdeşlik',
	ph_address: 'Garşy tarapyň MIGA salgysy',
	ph_name: 'Ady (diňe siz görýärsiňiz)',
	start_chat: 'Söhbedi başla',
	no_conversations: 'Entek söhbetdeşlik ýok. Başlamak üçin salgyňyzy biri bilen paýlaşyň.',
	back: 'Yza',
	no_messages: 'Entek hat ýok. Hatlar bu enjamdan çykmazdan öň şifrlenýär.',
	ph_message: 'Hat ýazyň',
	send: 'Ugrat',
	pick: 'Söhbetdeşlik saýlaň ýa-da biriniň MIGA salgysy bilen täzesini başlaň.',
	state_pending: 'ugradylmagyna garaşylýar',
	state_sent: 'ugradyldy',
	state_failed: 'ugradylmady',
	name_unknown: 'Näbelli',
	name_contact: 'Kontakt',
	n_relay_rejected: 'Relaý haty ret etdi: {code}',
	n_too_long: 'Bu hat gaty uzyn (çäk: {max} nyşan).',
	n_bad_address: 'Bu dogry MIGA salgysy däl (64 harp we san).',
	n_own_address: 'Bu siziň öz salgyňyz.',
	n_copied: 'Salgyňyz göçürildi.',
	n_copy_failed: 'Göçürip bolmady. Salgyny saýlap, el bilen göçüriň.',
	q_backup: 'Gizlin açaryňyz şahsyýetiňize doly elýeterlilik berýär. Ony göçürmelimi?',
	n_key_copied: 'Gizlin açar göçürildi. Ony ygtybarly ýerde saklaň we alyş-çalyş buferini arassalaň.',
	n_key_copy_failed: 'Açary göçürip bolmady.',
	q_restore_prompt: 'Dikeltmek üçin gizlin açary goýuň (64 nyşan):',
	n_bad_key: 'Bu dogry gizlin açar däl.',
	q_restore_confirm: 'Bu amal şu brauzerde saklanan şahsyýeti çalyşýar. Dowam etmelimi?'
};

const ru: Dictionary = {
	language: 'Язык',

	nav_app: 'Открыть приложение',
	nav_source: 'Исходный код',
	badge: 'Шифрование · Без аккаунта · Тестовый этап',
	lead: 'Мессенджер, созданный, чтобы люди оставались на связи в сетях с ограничениями. Без номера телефона и без e-mail: ваша личность — это ключ, который никогда не покидает ваше устройство.',
	cta_open: 'Открыть MIGA в браузере',
	cta_code: 'Посмотреть код',
	flow_1: 'Ваше устройство запечатывает сообщение ключом получателя.',
	flow_2: 'Ретранслятор передаёт запечатанный конверт по обычному HTTPS.',
	flow_3: 'Открыть его может только устройство получателя.',
	flow_note: 'Ретранслятор видит конверт, но никогда не видит письмо.',
	how_title: 'Как это работает',
	how_lead: 'Три идеи, намеренно простые.',
	f1_title: 'Сквозное шифрование',
	f1_text:
		'Сообщения шифруются на вашем устройстве. Ретранслятор лишь пересылает запечатанные конверты.',
	f2_title: 'Выглядит как обычный веб-трафик',
	f2_text: 'Всё идёт по стандартному HTTPS через порт 443, как у любого сайта.',
	f3_title: 'Нет центрального аккаунта',
	f3_text:
		'Ретранслятор можно заменить. Запустить его может кто угодно, и ваш ключ работает с любым из них.',
	part_title: 'Часть Vniverse77',
	part_lead: 'MIGA разрабатывается открыто вместе с остальными проектами Vniverse77.',
	forum_text: 'Вопросы, отзывы и отчёты о тестах. Расскажите, что работает в вашей сети.',
	site_text: 'Видео, записи в блоге и другие проекты, стоящие за MIGA.',
	warning:
		'MIGA — экспериментальный проект, он не проходил аудит безопасности. Пока не полагайтесь на него там, где от этого зависит ваша безопасность.',

	status_online: 'в сети',
	status_offline: 'нет связи',
	status_connecting: 'подключение',
	your_address: 'Ваш адрес',
	copy_address: 'Скопировать адрес',
	backup_key: 'Сохранить ключ',
	restore: 'Восстановить',
	new_conversation: 'Новый разговор',
	ph_address: 'MIGA-адрес собеседника',
	ph_name: 'Имя (видно только вам)',
	start_chat: 'Начать чат',
	no_conversations: 'Разговоров пока нет. Поделитесь своим адресом, чтобы начать.',
	back: 'Назад',
	no_messages: 'Сообщений пока нет. Сообщения шифруются до того, как покинут это устройство.',
	ph_message: 'Напишите сообщение',
	send: 'Отправить',
	pick: 'Выберите разговор или начните новый по MIGA-адресу собеседника.',
	state_pending: 'ожидает отправки',
	state_sent: 'отправлено',
	state_failed: 'не отправлено',
	name_unknown: 'Неизвестный',
	name_contact: 'Контакт',
	n_relay_rejected: 'Ретранслятор отклонил сообщение: {code}',
	n_too_long: 'Сообщение слишком длинное (предел: {max} символов).',
	n_bad_address: 'Это не действительный MIGA-адрес (64 буквы и цифры).',
	n_own_address: 'Это ваш собственный адрес.',
	n_copied: 'Ваш адрес скопирован.',
	n_copy_failed: 'Не удалось скопировать. Выделите адрес и скопируйте вручную.',
	q_backup: 'Секретный ключ даёт полный доступ к вашей личности. Скопировать его в буфер обмена?',
	n_key_copied: 'Секретный ключ скопирован. Сохраните его в надёжном месте и очистите буфер обмена.',
	n_key_copy_failed: 'Не удалось скопировать ключ.',
	q_restore_prompt: 'Вставьте секретный ключ для восстановления (64 символа):',
	n_bad_key: 'Это не действительный секретный ключ.',
	q_restore_confirm: 'Это заменит личность, сохранённую в этом браузере. Продолжить?'
};

const dictionaries = { en, tk, tr, ru } satisfies Record<string, Dictionary>;
export type Lang = keyof typeof dictionaries;

export const languages: { code: Lang; name: string }[] = [
	{ code: 'en', name: 'English' },
	{ code: 'tk', name: 'Türkmençe' },
	{ code: 'tr', name: 'Türkçe' },
	{ code: 'ru', name: 'Русский' }
];

const KEY_LANG = 'miga.lang';
const isLang = (value: unknown): value is Lang =>
	typeof value === 'string' && Object.hasOwn(dictionaries, value);

let current = $state<Lang>('en');

/** Reads the saved choice, or falls back to the browser's preferred languages. Browser only. */
export function initLanguage(): void {
	let saved: string | null = null;
	try {
		saved = localStorage.getItem(KEY_LANG);
	} catch {
		// Storage can be blocked; the browser language still applies.
	}
	const wanted = isLang(saved)
		? saved
		: navigator.languages.map((l) => l.slice(0, 2).toLowerCase()).find(isLang);
	if (wanted) current = wanted;
	document.documentElement.lang = current;
}

export function getLanguage(): Lang {
	return current;
}

export function setLanguage(lang: Lang): void {
	current = lang;
	document.documentElement.lang = lang;
	try {
		localStorage.setItem(KEY_LANG, lang);
	} catch {
		// Not saved; the choice still holds for this visit.
	}
}

/** Translates a key. Reading it inside a template keeps the text in step with the language. */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
	let text: string = dictionaries[current][key];
	if (vars) {
		for (const [name, value] of Object.entries(vars)) text = text.replace(`{${name}}`, String(value));
	}
	return text;
}
