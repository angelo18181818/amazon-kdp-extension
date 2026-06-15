// ==UserScript==
// @name         KDP Amazon Scanner
// @namespace    kdp-scanner
// @version      2.0
// @description  Scanner automatico per BSR, reviews, subcategories e self-published nei risultati Amazon.
// @author       Angel
// @match        https://www.amazon.com/s*
// @match        https://www.amazon.co.uk/s*
// @match        https://www.amazon.de/s*
// @match        https://www.amazon.fr/s*
// @match        https://www.amazon.it/s*
// @match        https://www.amazon.es/s*
// @match        https://www.amazon.ca/s*
// @match        https://www.amazon.com.au/s*
// @grant        GM_xmlhttpRequest
// @connect      www.amazon.com
// @connect      www.amazon.co.uk
// @connect      www.amazon.de
// @connect      www.amazon.fr
// @connect      www.amazon.it
// @connect      www.amazon.es
// @connect      www.amazon.ca
// @connect      www.amazon.com.au
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const MAX_CONCURRENT = 6;
    const ONLY_BOOKS = false;

    const dataCache = new Map();
    const promiseCache = new Map();
    const queuedCards = new WeakSet();

    let queue = [];
    let activeWorkers = 0;
    let observerStarted = false;

    function cleanText(text) {
        return (text || "")
            .replace(/[\u200e\u200f\u061c\u202a-\u202e]/g, "")
            .replace(/\s+/g, " ")
            .trim();
    }

    function cleanMultiline(text) {
        return (text || "")
            .replace(/[\u200e\u200f\u061c\u202a-\u202e]/g, "")
            .replace(/[ \t]+/g, " ")
            .replace(/\n\s+/g, "\n")
            .trim();
    }

    function htmlEscape(str) {
        return String(str || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function makeProductUrl(asin) {
        return `${location.origin}/dp/${asin}`;
    }

    function safeDecode(value) {
        if (!value) return "";
        try {
            return decodeURIComponent(value);
        } catch (e) {
            return value;
        }
    }

    function parseAsinFromUrl(href) {
        if (!href) return "";

        const variants = new Set();

        variants.add(href);
        variants.add(safeDecode(href));
        variants.add(safeDecode(safeDecode(href)));

        try {
            const url = new URL(href, location.href);
            variants.add(url.href);
            variants.add(safeDecode(url.href));

            const paramsToCheck = [
                "url",
                "u",
                "redirect",
                "redirectUrl",
                "rd",
                "r",
                "psc"
            ];

            for (const key of paramsToCheck) {
                const val = url.searchParams.get(key);
                if (val) {
                    variants.add(val);
                    variants.add(safeDecode(val));
                    variants.add(safeDecode(safeDecode(val)));
                }
            }
        } catch (e) {}

        for (const value of variants) {
            if (!value) continue;

            const direct =
                value.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?#&]|$)/i) ||
                value.match(/%2F(?:dp|gp%2Fproduct)%2F([A-Z0-9]{10})/i) ||
                value.match(/[?&](?:asin|ASIN)=([A-Z0-9]{10})(?:[&#]|$)/i);

            if (direct && direct[1]) {
                return direct[1].toUpperCase();
            }
        }

        return "";
    }

    function extractAsinFromElement(el) {
        if (!el) return "";

        const saved = el.getAttribute && el.getAttribute("data-kdp-asin");
        if (saved) return saved;

        const dataAsin = el.getAttribute && el.getAttribute("data-asin");
        if (dataAsin && /^[A-Z0-9]{10}$/i.test(dataAsin)) {
            return dataAsin.toUpperCase();
        }

        const directLink =
            el.matches && el.matches("a[href]")
                ? el
                : null;

        const link =
            directLink ||
            el.querySelector?.("a[href]");

        if (!link) return "";

        const href = link.getAttribute("href") || link.href || "";
        return parseAsinFromUrl(href);
    }

    function getAsin(card) {
        const saved = card.getAttribute("data-kdp-asin");
        if (saved) return saved;

        const asin = extractAsinFromElement(card);

        if (asin) {
            card.setAttribute("data-kdp-asin", asin);
        }

        return asin;
    }

    function isBookish(data) {
        if (!data || data.blocked) return false;

        const text = [
            data.mainRank?.category || "",
            ...(data.subRanks || []).map(r => r.category || "")
        ].join(" ");

        return /book|books|kindle|ebook|ebooks|audible|livre|livres|libro|libri|buch|bücher/i.test(text);
    }

    function removeBox(card) {
        const box = card.querySelector(".kdp-lux");
        if (box) box.remove();
    }

    function httpGet(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url,
                timeout: 20000,
                headers: {
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
                },
                onload: response => resolve(response.responseText),
                onerror: error => reject(error),
                ontimeout: () => reject(new Error("Timeout"))
            });
        });
    }

    function injectStyle() {
        if (document.querySelector("#kdp-lux-style")) return;

        const style = document.createElement("style");
        style.id = "kdp-lux-style";
        style.textContent = `
            .kdp-lux {
                position: relative;
                display: block;
                margin: 0 0 10px 0;
                padding: 9px 10px 10px;
                border-radius: 14px;
                background:
                    linear-gradient(135deg, rgba(18,18,18,.96) 0%, rgba(32,32,32,.95) 52%, rgba(46,37,12,.95) 100%);
                border: 1px solid rgba(212,175,55,.28);
                box-shadow:
                    0 10px 24px rgba(0,0,0,.18),
                    0 2px 10px rgba(212,175,55,.08),
                    inset 0 1px 0 rgba(255,255,255,.06);
                color: #f8f3df;
                font-family: Inter, Arial, sans-serif;
                font-size: 11.5px;
                line-height: 1.28;
                max-width: 100%;
                box-sizing: border-box;
                overflow: hidden;
                backdrop-filter: blur(8px);
            }

            .kdp-lux::before {
                content: "";
                position: absolute;
                inset: 0;
                background:
                    linear-gradient(110deg,
                        rgba(255,255,255,0) 0%,
                        rgba(255,255,255,.05) 14%,
                        rgba(255,255,255,0) 28%);
                pointer-events: none;
            }

            .kdp-lux.kdp-loading {
                background:
                    linear-gradient(135deg, rgba(25,33,62,.96) 0%, rgba(28,49,105,.95) 100%);
                border-color: rgba(108,156,255,.30);
                color: #eef5ff;
            }

            .kdp-lux.kdp-error {
                background:
                    linear-gradient(135deg, rgba(59,23,12,.96) 0%, rgba(106,44,13,.95) 100%);
                border-color: rgba(255,166,92,.35);
                color: #fff4ea;
            }

            .kdp-lux-top {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: 6px;
                margin-bottom: 6px;
            }

            .kdp-lux-brand {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                padding: 3px 8px;
                min-height: 22px;
                border-radius: 999px;
                font-size: 10px;
                font-weight: 900;
                letter-spacing: 1px;
                text-transform: uppercase;
                color: #15120a;
                background: linear-gradient(135deg, #f8e08b 0%, #d4af37 55%, #b8871c 100%);
                box-shadow:
                    0 1px 0 rgba(255,255,255,.22) inset,
                    0 4px 10px rgba(212,175,55,.18);
            }

            .kdp-lux-chip {
                display: inline-flex;
                align-items: center;
                gap: 5px;
                min-height: 22px;
                padding: 3px 8px;
                border-radius: 999px;
                background: rgba(255,255,255,.06);
                border: 1px solid rgba(212,175,55,.18);
                color: #f8f3df;
                box-shadow: inset 0 1px 0 rgba(255,255,255,.03);
                white-space: normal;
            }

            .kdp-lux-chip strong {
                display: inline-block;
                font-size: 9.8px;
                font-weight: 900;
                letter-spacing: .8px;
                text-transform: uppercase;
                color: #e3c25b;
                opacity: .98;
            }

            .kdp-lux-chip.sp-yes {
                background: linear-gradient(135deg, rgba(24,71,42,.85) 0%, rgba(18,45,31,.92) 100%);
                border-color: rgba(91,214,146,.26);
                color: #dcffe8;
            }

            .kdp-lux-chip.sp-no {
                background: linear-gradient(135deg, rgba(77,26,26,.76) 0%, rgba(45,20,20,.90) 100%);
                border-color: rgba(255,130,130,.20);
                color: #ffe3e3;
            }

            .kdp-lux-sub {
                display: flex;
                flex-wrap: wrap;
                gap: 5px;
            }

            .kdp-lux-subchip {
                display: inline-flex;
                align-items: center;
                padding: 3px 7px;
                border-radius: 8px;
                background: rgba(212,175,55,.08);
                border: 1px solid rgba(212,175,55,.15);
                color: #f0dd9e;
                font-size: 10.8px;
                box-shadow: inset 0 1px 0 rgba(255,255,255,.03);
                white-space: normal;
            }

            .kdp-lux-empty {
                opacity: .72;
                font-style: italic;
                font-size: 10.8px;
                color: #dccb92;
            }
        `;

        document.head.appendChild(style);
    }

    function findProductCardFromLink(link) {
        const known =
            link.closest('div[data-component-type="s-search-result"]') ||
            link.closest('li.a-carousel-card') ||
            link.closest('div.a-carousel-card') ||
            link.closest('.a-carousel-card') ||
            link.closest('[data-cy="asin-faceout-container"]') ||
            link.closest('[data-testid*="product"]') ||
            link.closest('.puis-card-container') ||
            link.closest('.AdHolder') ||
            link.closest('div[data-asin]') ||
            link.closest('li[data-asin]') ||
            link.closest('div[cel_widget_id]');

        if (known) return known;

        let node = link.parentElement;
        let best = null;

        for (let depth = 0; node && node !== document.body && depth < 10; depth++) {
            const text = cleanText(node.innerText || "");
            const imgCount = node.querySelectorAll("img").length;
            const linkCount = node.querySelectorAll("a[href]").length;
            const rect = node.getBoundingClientRect();

            const widthOk = !rect.width || (rect.width >= 80 && rect.width <= 420);
            const textOk = text.length >= 10 && text.length <= 1400;
            const linkOk = linkCount <= 12;

            if (imgCount >= 1 && widthOk && textOk && linkOk) {
                best = node;
                break;
            }

            node = node.parentElement;
        }

        return best || link.closest(".s-widget-container") || link.parentElement;
    }

    function normalizeCandidate(el) {
        return (
            el.closest('div[data-component-type="s-search-result"]') ||
            el.closest('[data-kdp-horizontal-card="1"]') ||
            el.closest('li.a-carousel-card') ||
            el.closest('div.a-carousel-card') ||
            el.closest('.a-carousel-card') ||
            el.closest('[data-cy="asin-faceout-container"]') ||
            el.closest('[data-testid*="product"]') ||
            el.closest('.puis-card-container') ||
            el.closest('.AdHolder') ||
            el.closest('div[data-asin]') ||
            el.closest('li[data-asin]') ||
            el.closest('div[cel_widget_id]') ||
            el
        );
    }

    function getCards() {
        const finalCards = new Set();

        document
            .querySelectorAll(`
                div[data-component-type="s-search-result"],
                div[data-asin],
                li[data-asin],
                .puis-card-container,
                .AdHolder,
                .a-carousel-card,
                li.a-carousel-card,
                div.a-carousel-card,
                [data-cy="asin-faceout-container"],
                [data-testid*="product"],
                div[cel_widget_id]
            `)
            .forEach(el => {
                const normalized = normalizeCandidate(el);
                const asin =
                    extractAsinFromElement(normalized) ||
                    extractAsinFromElement(el);

                if (!asin) return;

                normalized.setAttribute("data-kdp-asin", asin);
                finalCards.add(normalized);
            });

        document
            .querySelectorAll("a[href]")
            .forEach(link => {
                const href = link.getAttribute("href") || link.href || "";
                const asin = parseAsinFromUrl(href);

                if (!asin) return;

                const card = findProductCardFromLink(link);

                if (!card) return;

                card.setAttribute("data-kdp-asin", asin);
                card.setAttribute("data-kdp-horizontal-card", "1");

                const normalized = normalizeCandidate(card);
                normalized.setAttribute("data-kdp-asin", asin);
                finalCards.add(normalized);
            });

        return [...finalCards];
    }

    function getOrCreateBox(card) {
        const existingBoxes = card.querySelectorAll(".kdp-lux");

        if (existingBoxes.length > 0) {
            existingBoxes.forEach((box, index) => {
                if (index > 0) box.remove();
            });
            return existingBoxes[0];
        }

        const box = document.createElement("div");
        box.className = "kdp-lux";

        const container =
            card.querySelector(".s-card-container") ||
            card.querySelector(".puis-card-container") ||
            card.querySelector(".sg-col-inner") ||
            card;

        container.insertAdjacentElement("afterbegin", box);

        return box;
    }

    function markLoading(card, asin) {
        const box = getOrCreateBox(card);
        box.className = "kdp-lux kdp-loading";
        box.innerHTML = `
            <div class="kdp-lux-top">
                <span class="kdp-lux-brand">KDP</span>
                <span class="kdp-lux-chip"><strong>Scan</strong>${htmlEscape(asin)}</span>
            </div>
        `;
    }

    function markError(card, message) {
        const box = getOrCreateBox(card);
        box.className = "kdp-lux kdp-error";
        box.innerHTML = `
            <div class="kdp-lux-top">
                <span class="kdp-lux-brand">KDP</span>
                <span class="kdp-lux-chip"><strong>Err</strong>${htmlEscape(message)}</span>
            </div>
        `;
    }

    function extractLines(doc) {
        const selectors = [
            "#detailBullets_feature_div",
            "#detailBulletsWrapper_feature_div",
            "#productDetails_detailBullets_sections1",
            "#productDetails_db_sections",
            "#SalesRank",
            "#detailBullets_averageCustomerReviews"
        ];

        let chunks = [];

        selectors.forEach(sel => {
            const el = doc.querySelector(sel);
            if (el) chunks.push(cleanMultiline(el.innerText));
        });

        if (!chunks.length && doc.body) {
            chunks.push(cleanMultiline(doc.body.innerText));
        }

        return chunks
            .join("\n")
            .split("\n")
            .map(line => cleanText(line))
            .filter(Boolean);
    }

    function getField(lines, labelRegex) {
        for (const line of lines) {
            const normalized = line.replace(/\s*[:：]\s*/g, ": ");
            const parts = normalized.split(": ");

            if (parts.length < 2) continue;

            const label = cleanText(parts[0]);
            const value = cleanText(parts.slice(1).join(": "));

            if (labelRegex.test(label)) {
                return value;
            }
        }

        return "";
    }

    function extractPublisher(lines, detailText) {
        let publisher =
            getField(lines, /^Publisher$/i) ||
            getField(lines, /^Editore$/i) ||
            getField(lines, /^Éditeur$/i) ||
            getField(lines, /^Herausgeber$/i) ||
            "";

        if (publisher) {
            return cleanPublisherValue(publisher);
        }

        const patterns = [
            /Publisher\s*[:：]\s*(.*?)(?=\s+(?:Accessibility|Publication date|Language|File size|Screen Reader|Enhanced typesetting|X-Ray|Word Wise|Print length|Page Flip|Book\s+\d+\s+of\s+\d+|Best Sellers Rank|Customer Reviews|ASIN)\s*[:：]|$)/i,
            /Editore\s*[:：]\s*(.*?)(?=\s+(?:Data di pubblicazione|Lingua|Dimensioni file|Lunghezza stampa|Classifica|Recensioni|ASIN)\s*[:：]|$)/i,
            /Éditeur\s*[:：]\s*(.*?)(?=\s+(?:Date de publication|Langue|Taille du fichier|Classement|Commentaires|ASIN)\s*[:：]|$)/i,
            /Herausgeber\s*[:：]\s*(.*?)(?=\s+(?:Erscheinungstermin|Sprache|Dateigröße|Amazon Bestseller-Rang|Kundenrezensionen|ASIN)\s*[:：]|$)/i
        ];

        for (const pattern of patterns) {
            const match = detailText.match(pattern);
            if (match && match[1]) {
                return cleanPublisherValue(match[1]);
            }
        }

        return "";
    }

    function cleanPublisherValue(value) {
        return cleanText(value)
            .replace(/\s+(Accessibility|Publication date|Language|File size|Screen Reader|Enhanced typesetting|X-Ray|Word Wise|Print length|Page Flip|Book\s+\d+\s+of\s+\d+|Best Sellers Rank|Customer Reviews|ASIN)\s*:.*$/i, "")
            .replace(/\s+(Data di pubblicazione|Lingua|Dimensioni file|Lunghezza stampa|Classifica|Recensioni|ASIN)\s*:.*$/i, "")
            .trim();
    }

    function parseEnglishRanks(text) {
        const ranks = [];
        const pattern = /#\s*([\d,.]+)\s+in\s+(.+?)(?=\s+#\s*[\d,.]+\s+in\s+|$)/gi;

        let match;

        while ((match = pattern.exec(text)) !== null) {
            let rank = "#" + match[1].replace(/\s/g, "");
            let category = cleanText(match[2]);

            category = category
                .replace(/\(.*?Top\s+100.*?\)/gi, "")
                .replace(/\(See.*?\)/gi, "")
                .replace(/\(Voir.*?\)/gi, "")
                .replace(/\(Vedi.*?\)/gi, "")
                .replace(/\(.*?\)/g, "")
                .replace(/Customer Reviews.*$/i, "")
                .replace(/ASIN.*$/i, "")
                .replace(/Publisher.*$/i, "")
                .replace(/Publication date.*$/i, "")
                .replace(/Language.*$/i, "")
                .replace(/Print length.*$/i, "")
                .replace(/File size.*$/i, "")
                .trim();

            if (rank && category && category.length < 140) {
                ranks.push({ rank, category });
            }
        }

        return ranks;
    }

    function parseLocalizedMainRank(text) {
        const patterns = [
            /Classement des meilleures ventes d'Amazon\s*[:\s]*(?:n[°º]\s*)?([\d\s.,]+)\s+en\s+([^#]{2,120})/i,
            /Classifica\s+Best\s+Seller\s+di\s+Amazon\s*[:\s]*(?:n[°º]\s*)?([\d\s.,]+)\s+in\s+([^#]{2,120})/i,
            /Amazon\s+Bestseller-Rang\s*[:\s]*(?:Nr\.\s*)?([\d\s.,]+)\s+in\s+([^#]{2,120})/i,
            /Clasificación\s+en\s+los\s+más\s+vendidos\s+de\s+Amazon\s*[:\s]*(?:n[.ºo]*\s*)?([\d\s.,]+)\s+en\s+([^#]{2,120})/i
        ];

        for (const pattern of patterns) {
            const match = text.match(pattern);

            if (match) {
                return [{
                    rank: "#" + cleanText(match[1]).replace(/\s/g, ""),
                    category: cleanText(match[2])
                        .replace(/\(.*?\)/g, "")
                        .replace(/Customer Reviews.*$/i, "")
                        .replace(/ASIN.*$/i, "")
                        .replace(/Publisher.*$/i, "")
                        .trim()
                }];
            }
        }

        return [];
    }

    function parseRanks(text) {
        let ranks = parseEnglishRanks(text);
        if (!ranks.length) {
            ranks = parseLocalizedMainRank(text);
        }
        return ranks;
    }

    function parseReviews(text) {
        const result = {
            rating: "",
            count: ""
        };

        const match =
            text.match(/Customer Reviews\s*:\s*([0-9.]+)\s+[0-9.]+\s+out of 5 stars\s*\(([\d,.\s]+)\)/i) ||
            text.match(/([0-9.]+)\s+out of 5 stars\s*\(([\d,.\s]+)\)/i) ||
            text.match(/([0-9.]+)\s+su 5 stelle\s*\(([\d,.\s]+)\)/i) ||
            text.match(/([0-9.]+)\s+sur 5 étoiles\s*\(([\d,.\s]+)\)/i) ||
            text.match(/([0-9.]+)\s+von 5 Sternen\s*\(([\d,.\s]+)\)/i);

        if (match) {
            result.rating = cleanText(match[1]);
            result.count = cleanText(match[2]).replace(/\s/g, "");
        }

        return result;
    }

    function detectSelfPublished(publisher) {
        const p = cleanText(publisher).toLowerCase();

        if (/independently\s+published/i.test(p)) {
            return {
                label: "YES",
                className: "sp-yes",
                title: `Publisher: ${publisher}`
            };
        }

        return {
            label: "NO",
            className: "sp-no",
            title: publisher ? `Publisher: ${publisher}` : "Publisher non trovato"
        };
    }

    function parseBookData(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, "text/html");

        const bodyText = cleanText(doc.body ? doc.body.innerText : "");

        if (
            /Enter the characters you see below/i.test(bodyText) ||
            /Sorry, we just need to make sure you're not a robot/i.test(bodyText)
        ) {
            return {
                blocked: true
            };
        }

        const lines = extractLines(doc);
        const detailText = cleanText(lines.join(" "));

        const ranks = parseRanks(detailText);
        const reviews = parseReviews(detailText);
        const publisher = extractPublisher(lines, detailText);
        const selfPublished = detectSelfPublished(publisher);

        return {
            blocked: false,
            publisher,
            selfPublished,
            rating: reviews.rating,
            reviewCount: reviews.count,
            ranks,
            mainRank: ranks[0] || null,
            subRanks: ranks.slice(1)
        };
    }

    function renderData(card, data) {
        if (data.blocked) {
            markError(card, "Amazon CAPTCHA");
            return;
        }

        const box = getOrCreateBox(card);
        box.className = "kdp-lux";

        const main = data.mainRank
            ? `${htmlEscape(data.mainRank.rank)} ${htmlEscape(data.mainRank.category)}`
            : "—";

        const reviews = data.rating || data.reviewCount
            ? `${data.rating ? "⭐ " + htmlEscape(data.rating) : ""}${data.reviewCount ? " (" + htmlEscape(data.reviewCount) + ")" : ""}`
            : "—";

        const self = data.selfPublished || {
            label: "NO",
            className: "sp-no",
            title: "Publisher non trovato"
        };

        const subs = data.subRanks && data.subRanks.length
            ? data.subRanks
                .slice(0, 4)
                .map(r => `<span class="kdp-lux-subchip">${htmlEscape(r.rank)} ${htmlEscape(r.category)}</span>`)
                .join("")
            : `<span class="kdp-lux-empty">SUB —</span>`;

        box.innerHTML = `
            <div class="kdp-lux-top">
                <span class="kdp-lux-brand">KDP</span>

                <span class="kdp-lux-chip">
                    <strong>BSR</strong>
                    ${main}
                </span>

                <span class="kdp-lux-chip">
                    <strong>REV</strong>
                    ${reviews}
                </span>

                <span class="kdp-lux-chip ${self.className}" title="${htmlEscape(self.title)}">
                    <strong>SP</strong>
                    ${htmlEscape(self.label)}
                </span>
            </div>

            <div class="kdp-lux-sub">
                ${subs}
            </div>
        `;
    }

    async function scanCard(card) {
        const asin = getAsin(card);
        if (!asin) return;

        markLoading(card, asin);

        try {
            let data;

            if (dataCache.has(asin)) {
                data = dataCache.get(asin);
            } else {
                if (!promiseCache.has(asin)) {
                    const promise = httpGet(makeProductUrl(asin))
                        .then(html => parseBookData(html));

                    promiseCache.set(asin, promise);
                }

                data = await promiseCache.get(asin);
                dataCache.set(asin, data);
                promiseCache.delete(asin);
            }

            if (ONLY_BOOKS && !isBookish(data)) {
                removeBox(card);
                return;
            }

            renderData(card, data);
        } catch (err) {
            markError(card, "errore lettura");
        }
    }

    function enqueueCard(card) {
        const asin = getAsin(card);
        if (!asin) return;
        if (queuedCards.has(card)) return;

        queuedCards.add(card);
        queue.push(card);
        pumpQueue();
    }

    function pumpQueue() {
        while (activeWorkers < MAX_CONCURRENT && queue.length > 0) {
            const card = queue.shift();

            activeWorkers++;

            scanCard(card)
                .catch(() => {})
                .finally(() => {
                    activeWorkers--;
                    pumpQueue();
                });
        }
    }

    function scanVisibleResults() {
        const cards = getCards();
        for (const card of cards) {
            enqueueCard(card);
        }
    }

    function debounce(fn, delay = 500) {
        let timer = null;
        return function () {
            clearTimeout(timer);
            timer = setTimeout(fn, delay);
        };
    }

    function startObserver() {
        if (observerStarted) return;
        observerStarted = true;

        const debouncedScan = debounce(scanVisibleResults, 600);

        const observer = new MutationObserver(() => {
            debouncedScan();
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    function init() {
        injectStyle();

        setTimeout(scanVisibleResults, 700);
        setTimeout(scanVisibleResults, 1800);
        setTimeout(scanVisibleResults, 3500);
        setTimeout(scanVisibleResults, 6000);

        startObserver();
    }

    init();

})();