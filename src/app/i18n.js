/*
 * [HRVST] language. Russian or English, chosen from the browser's languages unless the person
 * picked one with the switch in the header. Strings are keyed by their English text: the page's
 * static text is translated in place here, and app.js passes its own strings through HRVST_I18N.t.
 * Runs before the Cumulus ID button script so the button gets its labels in the right language.
 */
(() => {
  const RU = {
    // Page
    "Your observations, your data.": "Ваши наблюдения — ваши данные.",
    "Capture what you see in public places. HRVST strips contact details and packages it. You keep it in your silo or list it, and buyers pay you in Harvest Credits. You receive 85 percent of every sale.":
      "Фиксируйте то, что видите в общественных местах. HRVST убирает контактные данные и упаковывает наблюдение. Вы храните его в своём хранилище или выставляете на продажу, а покупатели платят вам кредитами Harvest. Вы получаете 85 процентов от каждой продажи.",
    "Homes, schools, hospitals and military sites stay on your device unless you opt in.":
      "Жилые дома, школы, больницы и военные объекты остаются на вашем устройстве, если вы сами не дадите согласие.",
    "Sign in with your Cumulus ID to start. No Cumulus ID yet? Create one and you come straight back here, signed in.":
      "Чтобы начать, войдите через Cumulus ID. Ещё нет Cumulus ID? Создайте его — и сразу вернётесь сюда уже с выполненным входом.",
    "Silo": "Хранилище",
    "Market": "Рынок",
    "Missions": "Задания",
    "Purchases": "Покупки",
    "Credits": "Кредиты",
    "New capture": "Новое наблюдение",
    "What did you see?": "Что вы увидели?",
    "Lifted sidewalk slab outside the library, trip edge about two centimetres.": "Приподнятая плитка тротуара у библиотеки, перепад около двух сантиметров.",
    "Place": "Место",
    "Library approach": "Подход к библиотеке",
    "Kind of place": "Тип места",
    "Capture": "Зафиксировать",
    "Captures": "Наблюдения",
    "Packets": "Пакеты",
    "Listed packets. You see the place, quality and price before you buy; the observation and its proof come after.":
      "Выставленные пакеты. До покупки видны место, качество и цена; само наблюдение и его доказательство — после.",
    "library, aisle 6…": "библиотека, ряд 6…",
    "At most (credits)": "Не дороже (кредитов)",
    "Quality at least": "Качество не ниже",
    "any": "любое",
    "Order": "Порядок",
    "Newest": "Сначала новые",
    "Cheapest": "Сначала дешёвые",
    "Best quality": "Лучшее качество",
    "Search": "Найти",
    "Post a mission": "Разместить задание",
    "Title": "Название",
    "Accessible entrances on 4th": "Доступные входы на 4-й улице",
    "Brief": "Описание",
    "Document step-free public entrances. No faces or plates.": "Отметьте общественные входы без ступенек. Без лиц и номеров.",
    "Reward (credits)": "Награда (кредитов)",
    "Deadline in days (optional)": "Срок в днях (необязательно)",
    "none": "нет",
    "The reward is held from your credits until you accept a submission or cancel. With a deadline, a mission nobody has submitted to by then is cancelled and the reward comes back.":
      "Награда удерживается с ваших кредитов, пока вы не примете работу или не отмените задание. Если указан срок и к нему никто ничего не прислал, задание отменяется, а награда возвращается.",
    "Post mission": "Разместить задание",
    "Harvest Credits": "Кредиты Harvest",
    "credits": "кредитов",
    "Your data": "Ваши данные",
    "Download everything HRVST holds about you, or erase it. Erasing wipes your captures and packets, cancels the missions you posted that nobody has claimed (the reward comes back), and gives back missions you claimed. Licences you already sold stay with their buyers, and your credits stay yours.":
      "Скачайте всё, что HRVST хранит о вас, или сотрите это. Стирание удаляет ваши наблюдения и пакеты, отменяет размещённые вами задания, которые никто не взял (награда возвращается), и возвращает взятые вами задания. Уже проданные лицензии остаются у покупателей, а ваши кредиты остаются вашими.",
    "Download my data": "Скачать мои данные",
    "Erase my data": "Стереть мои данные",
    "Sections": "Разделы",

    // Cumulus ID button
    "Sign in with Cumulus ID": "Войти через Cumulus ID",
    "Create a Cumulus ID": "Создать Cumulus ID",
    "Sign out": "Выйти",

    // Places
    "Street": "Улица",
    "Shop": "Магазин",
    "Field / outdoors": "Поле / на открытом воздухе",
    "Public building": "Общественное здание",
    "Private residence (restricted)": "Частное жильё (ограничено)",
    "School (restricted)": "Школа (ограничено)",
    "Hospital (restricted)": "Больница (ограничено)",
    "Military site (restricted)": "Военный объект (ограничено)",
    "Home interior (restricted)": "Внутри жилья (ограничено)",

    // Statuses
    "captured": "зафиксировано",
    "refined": "обработано",
    "excluded": "исключено",
    "draft": "черновик",
    "private": "личное",
    "listed": "в продаже",
    "retired": "снято",
    "open": "открыто",
    "claimed": "взято",
    "submitted": "сдано",
    "accepted": "принято",
    "rejected": "отклонено",
    "cancelled": "отменено",

    // App messages
    "Please sign in again.": "Пожалуйста, войдите снова.",
    "Your sign-in ended. Please sign in again.": "Сеанс входа закончился. Пожалуйста, войдите снова.",
    "Request failed ({status})": "Запрос не выполнен ({status})",
    "{label}: done.": "{label}: готово.",
    "removed: {list}": "удалено: {list}",
    "Opt in: share this restricted place": "Согласие: поделиться этим ограниченным местом",
    "Refine": "Обработка",
    "Refine into a packet": "Сделать пакет",
    "No captures yet.": "Наблюдений пока нет.",
    "Price in credits": "Цена в кредитах",
    "quality {q}": "качество {q}",
    "{n} credits": "{n} кредитов",
    "Keep": "Сохранение",
    "Keep private": "Оставить себе",
    "List": "Выставление",
    "Update price": "Изменить цену",
    "List for sale": "Выставить на продажу",
    "Report to Architect": "Сообщение Architect",
    "Report as a fault": "Сообщить о неисправности",
    "Delete this packet? It leaves the market and cannot be listed again.": "Удалить этот пакет? Он уйдёт с рынка, и выставить его снова будет нельзя.",
    "Delete": "Удалить",
    "No packets yet. Refine a capture to make one.": "Пакетов пока нет. Обработайте наблюдение, чтобы его создать.",
    "expires {when}": "действует до {when}",
    "Yours": "Ваш",
    "Bought": "Куплено",
    "Buy a licence for {n} credits?": "Купить лицензию за {n} кредитов?",
    "Buy": "Покупка",
    "Buy for {n} credits": "Купить за {n} кредитов",
    "Nothing listed right now.": "Сейчас ничего не выставлено.",
    "Claim": "Взять",
    "Packet to submit": "Пакет для сдачи",
    "Keep or list a packet first.": "Сначала сохраните или выставьте пакет.",
    "Submit": "Сдать",
    "Release": "Возврат",
    "Give back": "Вернуть",
    "Accept and pay {n} credits?": "Принять и заплатить {n} кредитов?",
    "Accept": "Приём",
    "Accept and pay": "Принять и заплатить",
    "Reject": "Отклонить",
    "Cancel this mission and get the reward back?": "Отменить задание и вернуть награду?",
    "Cancel": "Отменить",
    "due {when}": "срок {when}",
    "you posted": "ваше задание",
    "you claimed": "вы взяли",
    "No missions right now.": "Сейчас заданий нет.",
    "Open": "Открыть",
    "Nothing bought yet.": "Пока ничего не куплено.",
    "No credit movements yet.": "Движений по кредитам пока нет.",
    "sold {count}×, earned {n}": "продано {count}×, заработано {n}",
    "Earned {n} credits from {count} sales of your packets.": "Заработано {n} кредитов на {count} продажах ваших пакетов.",
    "None of your packets has sold yet.": "Ни один из ваших пакетов ещё не продан.",
    "Proof of perspective": "Доказательство наблюдения",
    "Proof checked: it matches the observation and links into the chain.": "Доказательство проверено: оно совпадает с наблюдением и встроено в цепочку.",
    "Proof links into the chain. The contributor erased the original, so the text itself can no longer be rechecked.":
      "Доказательство встроено в цепочку. Автор стёр оригинал, поэтому сам текст перепроверить уже нельзя.",
    "Proof check failed: the chain does not hold. Contact HRVST before relying on this data.":
      "Проверка доказательства не пройдена: цепочка нарушена. Свяжитесь с HRVST, прежде чем полагаться на эти данные.",
    "captured {when}": "зафиксировано {when}",
    "Download": "Скачивание",
    "Erase": "Стирание",
    'This cannot be undone. Type "erase" to erase your HRVST data.': "Это нельзя отменить. Введите «erase», чтобы стереть ваши данные в HRVST.",
    "Erased {captures} captures and {packets} packets; {cancelled} missions cancelled, {released} given back.":
      "Стёрто наблюдений: {captures}, пакетов: {packets}; отменено заданий: {cancelled}, возвращено: {released}.",
    "Post mission…": "Размещение задания…",
    "Search failed: {error}": "Поиск не удался: {error}",
    "English": "English",
    "Русский": "Русский",
    "Language": "Язык",
  };

  const KEY = "hrvst:lang";
  const saved = (() => { try { return window.localStorage.getItem(KEY); } catch { return null; } })();
  const wanted = (typeof navigator !== "undefined" && (navigator.languages || [navigator.language])) || [];
  const lang = saved === "ru" || saved === "en" ? saved : wanted.some((l) => /^ru\b/i.test(String(l || ""))) ? "ru" : "en";

  /** t("Buy for {n} credits", { n: 5 }) — the Russian text when Russian is on, else the English. */
  function t(text, vars) {
    const out = lang === "ru" && Object.prototype.hasOwnProperty.call(RU, text) ? RU[text] : text;
    return vars ? out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : out;
  }

  function setLang(next) {
    try { window.localStorage.setItem(KEY, next); } catch { /* private mode: the choice lasts this page only */ }
    window.location.reload();
  }

  /** Translate the page's own text, placeholders and labels; whitespace around each text is kept. */
  function translatePage(root) {
    if (lang !== "ru") return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const raw = node.nodeValue;
      const key = raw.trim();
      if (key && Object.prototype.hasOwnProperty.call(RU, key)) node.nodeValue = raw.replace(key, RU[key]);
    }
    for (const attr of ["placeholder", "aria-label", "title"]) {
      for (const el of root.querySelectorAll(`[${attr}]`)) el.setAttribute(attr, t(el.getAttribute(attr)));
    }
  }

  function setup() {
    document.documentElement.lang = lang;
    translatePage(document.body);
    for (const host of document.querySelectorAll("[data-cumulus-id]")) {
      host.dataset.label = t("Sign in with Cumulus ID");
      host.dataset.createLabel = t("Create a Cumulus ID");
      host.dataset.signOutLabel = t("Sign out");
    }
    const sw = document.getElementById("lang-switch");
    if (sw) {
      const other = lang === "ru" ? "en" : "ru";
      sw.textContent = other === "ru" ? "Русский" : "English";
      sw.setAttribute("lang", other);
      sw.setAttribute("aria-label", `${t("Language")}: ${sw.textContent}`);
      sw.hidden = false;
      sw.addEventListener("click", () => setLang(other));
    }
  }

  window.HRVST_I18N = { lang, t, RU };
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup);
    else setup();
  }
})();
