// ==UserScript==
// @name         VK Album booking parser (by user, modal next)
// @namespace    vk-album-booking-parser
// @version      1.2.0
// @description  Парсит комментарии с "бронь" в альбомах VK. Группирует: юзер -> список фото. Листает фото в модалке без закрытия. Экспорт CSV.
// @match        https://vk.com/album*
// @grant        GM_addStyle
// ==/UserScript==

(function () {
  "use strict";

  // -------------------- utils --------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const norm = (s) =>
    String(s ?? "")
      .toLowerCase()
      .replaceAll("ё", "е")
      .replace(/\s+/g, " ")
      .trim();

  function isBron(text) {
    const t = norm(text);
    return /(^|[^a-zа-яё0-9])бронь([^a-zа-яё0-9]|$)/i.test(t);
  }

  function absVkUrl(href) {
    if (!href) return "";
    if (href.startsWith("http")) return href;
    if (href.startsWith("/")) return `https://vk.com${href}`;
    return `https://vk.com/${href}`;
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  async function waitFor(
    selector,
    { root = document, timeout = 15000, poll = 100 } = {}
  ) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const el = root.querySelector(selector);
      if (el) return el;
      await sleep(poll);
    }
    return null;
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // -------------------- UI --------------------
  GM_addStyle(`
    #bron-ui {
      position: fixed; left: 16px; bottom: 16px; z-index: 999999;
      width: 440px; max-height: 75vh; overflow: auto;
      background: #111; color: #eee; border: 1px solid #333;
      border-radius: 12px; padding: 12px; font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial;
      box-shadow: 0 12px 40px rgba(0,0,0,.35);
    }
    #bron-ui button {
      cursor: pointer; border: 1px solid #444; background: #1b1b1b; color: #eee;
      padding: 8px 10px; border-radius: 10px; margin-right: 8px;
    }
    #bron-ui button:hover { background: #242424; }
    #bron-ui .row { margin-top: 8px; }
    #bron-ui .muted { color: #aaa; font-size: 12px; }
    #bron-ui table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12px; }
    #bron-ui th, #bron-ui td { border-bottom: 1px solid #2a2a2a; padding: 6px 4px; vertical-align: top; }
    #bron-ui a { color: #8ab4ff; text-decoration: none; }
    #bron-ui a:hover { text-decoration: underline; }
    #bron-ui .pill {
      display: inline-block; padding: 2px 8px; border: 1px solid #333; border-radius: 999px;
      font-size: 12px; color: #bbb; margin-left: 6px;
    }
    #bron-ui .photos { display: flex; flex-wrap: wrap; gap: 6px; }
    #bron-ui .photos a {
      border: 1px solid #2a2a2a; border-radius: 999px; padding: 2px 8px;
      font-size: 12px; display: inline-block; max-width: 170px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
  `);

  const ui = document.createElement("div");
  ui.id = "bron-ui";
  ui.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
      <div>
        <div style="font-weight:600;">VK → бронь в альбоме</div>
        <div class="muted">юзер → список фоток (листает в модалке)</div>
      </div>
      <div class="pill" id="bron-state">idle</div>
    </div>

    <div class="row">
      <button id="bron-start">Старт</button>
      <button id="bron-stop" disabled>Стоп</button>
      <button id="bron-csv" disabled>CSV</button>
      <button id="bron-clear">Очистить</button>
    </div>

    <div class="row muted" id="bron-log">Готов.</div>
    <div class="row" id="bron-out"></div>
  `;
  document.body.appendChild(ui);

  const $state = ui.querySelector("#bron-state");
  const $log = ui.querySelector("#bron-log");
  const $out = ui.querySelector("#bron-out");
  const $start = ui.querySelector("#bron-start");
  const $stop = ui.querySelector("#bron-stop");
  const $csv = ui.querySelector("#bron-csv");
  const $clear = ui.querySelector("#bron-clear");

  const setState = (s) => ($state.textContent = s);
  const log = (s) => ($log.textContent = s);

  // -------------------- data: user -> Set(photoUrl) --------------------
  let stopFlag = false;
  /** @type {Map<string, Set<string>>} */
  let userToPhotos = new Map();

  function toRows() {
    const rows = [];
    for (const [user_url, set] of userToPhotos.entries()) {
      const photos = Array.from(set);
      photos.sort();
      rows.push({ user_url, photos });
    }
    rows.sort(
      (a, b) =>
        b.photos.length - a.photos.length ||
        a.user_url.localeCompare(b.user_url)
    );
    return rows;
  }

  function renderTable() {
    const rows = toRows();
    if (!rows.length) {
      $out.innerHTML = `<div class="muted">Пока нет совпадений.</div>`;
      $csv.disabled = true;
      return;
    }
    $csv.disabled = false;

    const shown = rows.slice(0, 150);
    $out.innerHTML = `
      <div class="muted">Юзеров: ${rows.length}</div>
      <table>
        <thead><tr><th>Юзер</th><th>Фотки</th></tr></thead>
        <tbody>
          ${shown
            .map(
              (r) => `
            <tr>
              <td>
                <a href="${r.user_url}" target="_blank">${escapeHtml(
                r.user_url.replace("https://vk.com/", "vk.com/")
              )}</a>
                <div class="muted">фото: ${r.photos.length}</div>
              </td>
              <td>
                <div class="photos">
                  ${r.photos
                    .slice(0, 24)
                    .map(
                      (p) => `
                    <a href="${p}" target="_blank">${escapeHtml(
                        p.replace("https://vk.com/", "vk.com/")
                      )}</a>
                  `
                    )
                    .join("")}
                  ${
                    r.photos.length > 24
                      ? `<span class="muted">+${
                          r.photos.length - 24
                        } ещё</span>`
                      : ``
                  }
                </div>
              </td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table>
    `;
  }

  function exportCSV() {
    const rows = toRows();
    const esc = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
    const lines = [];
    lines.push([esc("user_url"), esc("photo_urls")].join(","));
    for (const r of rows)
      lines.push([esc(r.user_url), esc(r.photos.join("; "))].join(","));
    return lines.join("\n");
  }

  // -------------------- album load --------------------
  function collectPhotoAnchors() {
    const anchors = Array.from(
      document.querySelectorAll('a[href^="/photo"], a[href*="/photo-"]')
    ).filter((a) => /\/photo-?\d+_\d+/.test(a.getAttribute("href") || ""));
    const map = new Map();
    for (const a of anchors) map.set(a.getAttribute("href"), a);
    return Array.from(map.values());
  }

  async function scrollAlbumToLoad({ maxIdle = 12, stepDelay = 900 } = {}) {
    let last = 0;
    let idle = 0;
    while (idle < maxIdle && !stopFlag) {
      const count = collectPhotoAnchors().length;
      if (count > last) {
        last = count;
        idle = 0;
        log(`Подгружаю превью… фоток видно: ${count}`);
      } else {
        idle++;
        log(`Жду догрузку… (${idle}/${maxIdle}) фоток видно: ${count}`);
      }
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(stepDelay);
    }
    window.scrollTo(0, 0);
    return collectPhotoAnchors();
  }

  async function openPhotoByAnchor(a) {
    a.scrollIntoView({ block: "center" });
    await sleep(120);
    a.click();
  }

  function closeModalIfOpen() {
    const btn = document.querySelector(".pv_close_btn");
    if (btn) btn.click();
  }

  // -------------------- modal helpers --------------------
  function ensureModalOpen() {
    return !!document.querySelector("#pv_box, .pv_box, .pv_photo_wrap");
  }

  function getModalCounter() {
    const el = document.querySelector(".pv_counter");
    const t = el?.textContent?.trim() || "";
    const m = t.match(/(\d+)\s+из\s+(\d+)/i);
    if (!m) return null;
    return { index: Number(m[1]), total: Number(m[2]) };
  }

  function getModalPhotoId() {
    const likeWrap = document.querySelector(
      '.pv_narrow_column_wrap .like_wrap[class*="_like_photo-"]'
    );
    if (!likeWrap) return "";
    const cls = Array.from(likeWrap.classList).find((c) =>
      c.startsWith("_like_photo-")
    );
    if (!cls) return "";
    return cls.replace("_like_", ""); // "photo-211108273_457262841"
  }

  function getModalPhotoUrl() {
    const id = getModalPhotoId();
    return id ? `https://vk.com/${id}` : "";
  }

  async function ensureCommentsLoaded() {
    const pv = await waitFor(".pv_photo_wrap, #pv_narrow_column_wrap", {
      timeout: 15000,
    });
    if (!pv) return false;
    const list = await waitFor("#pv_comments_list", { timeout: 15000 });
    if (!list) return false;
    await sleep(200);
    return true;
  }

  async function scrollCommentsColumnToLoadMore({
    rounds = 14,
    pause = 420,
  } = {}) {
    const scroller =
      document.querySelector(
        "#pv_narrow.ui_scroll_container .ui_scroll_content"
      ) ||
      document.querySelector("#pv_narrow") ||
      document.querySelector(".pv_narrow_column_wrap");

    if (!scroller) return;

    let lastCount = 0;
    let stable = 0;

    for (let i = 0; i < rounds && !stopFlag; i++) {
      const list = document.querySelector("#pv_comments_list");
      const count = list ? list.querySelectorAll(".reply").length : 0;

      if (count > lastCount) {
        lastCount = count;
        stable = 0;
      } else {
        stable++;
      }

      if ("scrollTop" in scroller) scroller.scrollTop = scroller.scrollHeight;
      await sleep(pause);

      if (stable >= 3) break;
    }
  }

  function parseBronFromCurrentModal() {
    const list = document.querySelector("#pv_comments_list");
    if (!list) return 0;

    const photoUrl = getModalPhotoUrl() || location.href;
    let added = 0;

    const replies = Array.from(list.querySelectorAll(".reply"));
    for (const r of replies) {
      const authorA = r.querySelector(".reply_author a.author, a.author[href]");
      const textEl = r.querySelector(
        ".reply_text .wall_reply_text, .reply_text, .wall_reply_text"
      );
      const text = textEl ? textEl.textContent.trim() : "";
      if (!text) continue;

      if (!isBron(text)) continue;

      const fromId = authorA?.getAttribute("data-from-id");
      const href = authorA?.getAttribute("href") || "";
      const userUrl = fromId ? `https://vk.com/id${fromId}` : absVkUrl(href);
      if (!userUrl) continue;

      if (!userToPhotos.has(userUrl)) userToPhotos.set(userUrl, new Set());
      const set = userToPhotos.get(userUrl);
      const before = set.size;
      set.add(photoUrl);
      if (set.size > before) added++;
    }

    return added;
  }

  function clickNextInModal() {
    // 1) direct Photoview.show (самый надёжный)
    try {
      if (
        typeof window.Photoview?.show === "function" &&
        typeof window.cur?.pvIndex === "number"
      ) {
        window.cur.pvClicked = true;
        window.Photoview.show(false, window.cur.pvIndex + 1, null);
        return true;
      }
    } catch {}

    // 2) call onmousedown on button
    const btn = document.querySelector("#pv_nav_btn_right");
    if (!btn) return false;

    try {
      if (typeof btn.onmousedown === "function") {
        btn.onmousedown({
          type: "mousedown",
          button: 0,
          which: 1,
          target: btn,
        });
        return true;
      }
    } catch {}

    // 3) dispatch simple events (no MouseEvent(view))
    try {
      btn.dispatchEvent(
        new Event("mousedown", { bubbles: true, cancelable: true })
      );
      btn.dispatchEvent(
        new Event("mouseup", { bubbles: true, cancelable: true })
      );
      btn.dispatchEvent(
        new Event("click", { bubbles: true, cancelable: true })
      );
      return true;
    } catch {}

    // 4) fallback click
    try {
      btn.click();
      return true;
    } catch {}

    return false;
  }

  async function waitPhotoChange(prevId, prevIndex, { timeout = 15000 } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const id = getModalPhotoId();
      const c = getModalCounter();
      const idx = c?.index ?? null;

      const idChanged = id && id !== prevId;
      const idxChanged =
        prevIndex != null && idx != null ? idx !== prevIndex : false;

      if (idChanged || idxChanged) return { id, index: idx };
      await sleep(80);
    }
    return null;
  }

  // -------------------- main --------------------
  async function run() {
    stopFlag = false;
    userToPhotos = new Map();
    renderTable();

    setState("loading");
    $start.disabled = true;
    $stop.disabled = false;

    log("Готовлю альбом (догружаю превью)…");
    await scrollAlbumToLoad();

    const first = collectPhotoAnchors()[0];
    if (!first) {
      setState("idle");
      log("Не нашёл ни одной фотки в альбоме.");
      $start.disabled = false;
      $stop.disabled = true;
      return;
    }

    closeModalIfOpen();
    await sleep(200);

    log("Открываю первую фотку…");
    await openPhotoByAnchor(first);

    const ok = await ensureCommentsLoaded();
    if (!ok || !ensureModalOpen()) {
      setState("idle");
      log("Не смог открыть модалку/комменты (возможно, VK изменил верстку).");
      $start.disabled = false;
      $stop.disabled = true;
      return;
    }

    setState("working");

    let counter = getModalCounter();
    const total = counter?.total ?? null;

    let prevId = getModalPhotoId();

    const maxSteps = total ?? 100000;

    for (let step = 1; step <= maxSteps && !stopFlag; step++) {
      counter = getModalCounter();
      const idx = counter?.index ?? step;
      const tot = counter?.total ?? total ?? "?";

      await ensureCommentsLoaded();
      await scrollCommentsColumnToLoadMore({ rounds: 14, pause: 420 });

      const added = parseBronFromCurrentModal();
      if (added > 0) {
        log(`(${idx}/${tot}) 🔥 Бронь найдена: +${added}`);
        renderTable();
      } else {
        log(`(${idx}/${tot}) Брони нет.`);
      }

      // если последняя — выходим
      if (counter && counter.total && counter.index >= counter.total) break;

      const prevIndex = counter?.index ?? null;

      const clicked = clickNextInModal();
      if (!clicked) {
        log("Не получилось нажать “вперёд” — останавливаюсь.");
        break;
      }

      const changed = await waitPhotoChange(prevId, prevIndex, {
        timeout: 15000,
      });
      if (!changed) {
        log("Не дождался переключения на следующую фотку — останавливаюсь.");
        break;
      }

      prevId = changed.id || prevId;
      await sleep(150);
    }

    setState(stopFlag ? "stopped" : "done");
    const rowsCount = toRows().length;
    const totalLinks = Array.from(userToPhotos.values()).reduce(
      (acc, s) => acc + s.size,
      0
    );
    log(`Готово. Юзеров: ${rowsCount}, всего фото-ссылок: ${totalLinks}`);

    renderTable();
    $start.disabled = false;
    $stop.disabled = true;

    // модалку НЕ закрываем — по твоей просьбе
  }

  // -------------------- handlers --------------------
  $start.addEventListener("click", () => {
    run().catch((e) => {
      console.error(e);
      setState("error");
      log(`Ошибка: ${e?.message || e}`);
      $start.disabled = false;
      $stop.disabled = true;
    });
  });

  $stop.addEventListener("click", () => {
    stopFlag = true;
    log("Останавливаю…");
  });

  $csv.addEventListener("click", () => {
    downloadText("vk_album_bron_by_user.csv", exportCSV());
  });

  $clear.addEventListener("click", () => {
    userToPhotos = new Map();
    renderTable();
    setState("idle");
    log("Очищено.");
  });

  renderTable();
})();
