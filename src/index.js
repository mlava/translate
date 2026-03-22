import iziToast from "izitoast";
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const DEFAULT_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 500;

function buildHeaders(rAPIkey) {
    const headers = new Headers();
    headers.set("x-rapidapi-key", rAPIkey);
    headers.set("x-rapidapi-host", "deep-translate1.p.rapidapi.com");
    headers.set("Content-Type", "application/json");
    return headers;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function protectMarkup(input) {
    const map = [];
    const toToken = (match) => {
        const token = `__DTPLACEHOLDER_${map.length}__`;
        map.push(match);
        return token;
    };
    let text = input;
    const patterns = [
        /```[\s\S]*?```/g, // fenced code blocks
        /`[^`]*`/g, // inline code
        /\(\([^)]+\)\)/g, // Roam block refs
        /\[\[[^\]]+\]\]/g, // Roam page refs
        /\{\{[^}]+\}\}/g, // Roam components
        /\[([^\]]+)\]\(([^)]+)\)/g, // markdown links
        /https?:\/\/[^\s)]+/g // raw URLs
    ];
    for (const pattern of patterns) {
        text = text.replace(pattern, toToken);
    }
    return { text, map };
}

function restoreMarkup(input, map) {
    let text = input;
    for (let i = 0; i < map.length; i++) {
        const token = `__DTPLACEHOLDER_${i}__`;
        text = text.split(token).join(map[i]);
    }
    return text;
}

async function fetchWithRetry(url, options, { retries = DEFAULT_RETRIES, baseDelayMs = DEFAULT_BASE_DELAY_MS } = {}) {
    let attempt = 0;
    while (true) {
        try {
            const response = await fetch(url, options);
            if (!RETRYABLE_STATUS.has(response.status) || attempt >= retries) {
                return response;
            }
            const delay = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * baseDelayMs);
            console.warn("retrying request", { url, status: response.status, attempt: attempt + 1, delayMs: delay });
            await sleep(delay);
            attempt += 1;
        } catch (err) {
            if (attempt >= retries) {
                throw err;
            }
            const delay = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * baseDelayMs);
            console.warn("retrying request after network error", { url, attempt: attempt + 1, delayMs: delay });
            await sleep(delay);
            attempt += 1;
        }
    }
}

async function detectLanguage(text, headers) {
    const response = await fetchWithRetry(
        "https://deep-translate1.p.rapidapi.com/language/translate/v2/detect",
        { method: "POST", headers, body: JSON.stringify({ q: text }), redirect: "follow" }
    );
    if (!response.ok) throw new Error(`Detect failed: HTTP ${response.status}`);
    const result = await response.json();
    const detected = result?.data?.detections?.[0]?.language;
    if (!detected) throw new Error("Detect failed: no language in response");
    return detected;
}

async function translateRaw(text, sourceLanguage, targetLanguage, headers) {
    const response = await fetchWithRetry(
        "https://deep-translate1.p.rapidapi.com/language/translate/v2",
        { method: "POST", headers, body: JSON.stringify({ q: text, source: sourceLanguage, target: targetLanguage }), redirect: "follow" }
    );
    if (!response.ok) throw new Error(`Translate failed: HTTP ${response.status}`);
    const result = await response.json();
    if (result.hasOwnProperty("message")) throw new Error("Too many API calls");
    return result.data.translations.translatedText.toString();
}

const EXTENSION_TOOLS_ID = "translate";

function registerExtensionTools(extensionAPI) {
    if (typeof window === "undefined") return;
    const registry = (window.RoamExtensionTools = window.RoamExtensionTools || {});

    function getConfig() {
        const rAPIkey = extensionAPI.settings.get("dt-rAPI-key");
        if (!rAPIkey) return { error: "RapidAPI key not configured. Set it in Translate extension settings." };
        const targetLanguage = extensionAPI.settings.get("dt-lang") || "en";
        const headers = buildHeaders(rAPIkey);
        return { rAPIkey, targetLanguage, headers };
    }

    function getBlockString(uid) {
        const data = window.roamAlphaAPI?.data?.pull
            ? window.roamAlphaAPI.data.pull("[:block/string]", [":block/uid", uid])
            : null;
        if (!data) return null;
        return data[":block/string"] || "";
    }

    registry[EXTENSION_TOOLS_ID] = {
        name: "Translate",
        version: "1.0",
        tools: [
            {
                name: "dt_translate_block",
                description: "Translate a Roam block's text to a target language. Creates a child block with the translated text.",
                readOnly: false,
                parameters: {
                    type: "object",
                    properties: {
                        block_uid: { type: "string", description: "UID of the block to translate." },
                        target_language: { type: "string", description: "Two-letter ISO 639-1 target language code (e.g. 'en', 'es', 'fr'). Defaults to the extension's configured preferred language." },
                        source_language: { type: "string", description: "Two-letter ISO 639-1 source language code. If omitted, auto-detected." },
                    },
                    required: ["block_uid"],
                },
                execute: async (args = {}) => {
                    try {
                        const cfg = getConfig();
                        if (cfg.error) return { error: cfg.error };
                        const { headers } = cfg;
                        const target = args.target_language || cfg.targetLanguage;
                        const blockStr = getBlockString(args.block_uid);
                        if (blockStr === null) return { error: `Block not found: ${args.block_uid}` };
                        if (!blockStr.trim()) return { error: "Block is empty — nothing to translate." };

                        const searchString = blockStr.replace(/[\r\n]/gm, "");
                        const prot = protectMarkup(searchString);
                        const source = args.source_language || await detectLanguage(prot.text, headers);
                        const translated = await translateRaw(prot.text, source, target, headers);
                        const restored = restoreMarkup(translated, prot.map);

                        const childUid = window.roamAlphaAPI.util.generateUID();
                        await window.roamAlphaAPI.createBlock({
                            location: { "parent-uid": args.block_uid, order: "last" },
                            block: { string: restored, uid: childUid },
                        });
                        return { success: true, block_uid: childUid, source_language: source, target_language: target, translated_text: restored };
                    } catch (err) {
                        return { error: err.message || "Translation failed" };
                    }
                },
            },
            {
                name: "dt_translate_children",
                description: "Translate all child blocks of a parent block. Creates a child block under each with the translated text.",
                readOnly: false,
                parameters: {
                    type: "object",
                    properties: {
                        parent_uid: { type: "string", description: "UID of the parent block whose children will be translated." },
                        target_language: { type: "string", description: "Two-letter ISO 639-1 target language code. Defaults to the extension's configured preferred language." },
                        source_language: { type: "string", description: "Two-letter ISO 639-1 source language code. If omitted, auto-detected from the first child." },
                        detect_each: { type: "boolean", description: "If true, detect the source language individually for each child block. Default false." },
                    },
                    required: ["parent_uid"],
                },
                execute: async (args = {}) => {
                    try {
                        const cfg = getConfig();
                        if (cfg.error) return { error: cfg.error };
                        const { headers } = cfg;
                        const target = args.target_language || cfg.targetLanguage;

                        const q = `[:find (pull ?page [:block/string :block/uid :block/order {:block/children ...}]) :where [?page :block/uid "${args.parent_uid}"]]`;
                        const info = await window.roamAlphaAPI.q(q);
                        const children = info?.[0]?.[0]?.children;
                        if (!children || children.length === 0) return { error: "No child blocks found." };

                        children.sort((a, b) => a.order - b.order);
                        const results = [];
                        let sharedSource = args.source_language || null;

                        for (let i = 0; i < children.length; i++) {
                            const child = children[i];
                            const raw = (child.string || "").replace(/[\r\n]/gm, "");
                            if (!raw.trim()) { results.push({ block_uid: child.uid, skipped: true, reason: "empty" }); continue; }

                            const prot = protectMarkup(raw);
                            let source;
                            if (args.detect_each || (!sharedSource && i === 0)) {
                                source = await detectLanguage(prot.text, headers);
                                if (!args.detect_each) sharedSource = source;
                            } else {
                                source = sharedSource;
                            }

                            const translated = await translateRaw(prot.text, source, target, headers);
                            const restored = restoreMarkup(translated, prot.map);
                            const childUid = window.roamAlphaAPI.util.generateUID();
                            await window.roamAlphaAPI.createBlock({
                                location: { "parent-uid": child.uid, order: "last" },
                                block: { string: restored, uid: childUid },
                            });
                            results.push({ block_uid: childUid, source_language: source, translated_text: restored });
                        }
                        return { success: true, target_language: target, results };
                    } catch (err) {
                        return { error: err.message || "Translation failed" };
                    }
                },
            },
            {
                name: "dt_translate_text",
                description: "Translate raw text and return the result without modifying any blocks. Useful for understanding foreign text without side effects.",
                readOnly: true,
                parameters: {
                    type: "object",
                    properties: {
                        text: { type: "string", description: "The text to translate." },
                        target_language: { type: "string", description: "Two-letter ISO 639-1 target language code. Defaults to the extension's configured preferred language." },
                        source_language: { type: "string", description: "Two-letter ISO 639-1 source language code. If omitted, auto-detected." },
                    },
                    required: ["text"],
                },
                execute: async (args = {}) => {
                    try {
                        const cfg = getConfig();
                        if (cfg.error) return { error: cfg.error };
                        const { headers } = cfg;
                        const target = args.target_language || cfg.targetLanguage;

                        const prot = protectMarkup(args.text);
                        const source = args.source_language || await detectLanguage(prot.text, headers);
                        const translated = await translateRaw(prot.text, source, target, headers);
                        const restored = restoreMarkup(translated, prot.map);
                        return { success: true, source_language: source, target_language: target, translated_text: restored };
                    } catch (err) {
                        return { error: err.message || "Translation failed" };
                    }
                },
            },
        ],
    };
}

function unregisterExtensionTools() {
    if (typeof window !== "undefined" && window.RoamExtensionTools) {
        delete window.RoamExtensionTools[EXTENSION_TOOLS_ID];
    }
}

const config = {
    tabTitle: "Translate",
    settings: [
        {
            id: "dt-rAPI-key",
            name: "RapidAPI Key",
            description: "Your API Key for RapidAPI from https://rapidapi.com/gatzuma/api/deep-translate1",
            action: { type: "input", placeholder: "Add RapidAPI API key here" },
        },
        {
            id: "dt-lang",
            name: "Preferred Language",
            description: "Two-letter language code from https://en.wikipedia.org/wiki/List_of_ISO_639-1_codes",
            action: { type: "input", placeholder: "en" },
        },
        {
            id: "dt-prompt",
            name: "Always prompt for source language",
            description: "Prompt user for source language, don't use detect",
            action: {
                type: "switch",
            },
        },
    ]
};

export default {
    onload: ({ extensionAPI }) => {
    extensionAPI.settings.panel.create(config);
    registerExtensionTools(extensionAPI);

    extensionAPI.ui.commandPalette.addCommand({
        label: "Translate using Deep Translate (Current block)",
        callback: () => {
            return getTrans({ extensionAPI }, true, false);
        }
    });
    extensionAPI.ui.commandPalette.addCommand({
        label: "Translate using Deep Translate (All Child blocks, Same language)",
        callback: () => {
            return getTrans({ extensionAPI }, false, true);
        }
    });
    extensionAPI.ui.commandPalette.addCommand({
        label: "Translate using Deep Translate (All Child blocks, Multiple languages)",
        callback: () => {
            return getTrans({ extensionAPI }, false, false);
        }
    });
},
onunload: () => {
    unregisterExtensionTools();
}
}

async function getTrans({ extensionAPI }, parentOnly, oneLang) {
    var rAPIkey, rAPIcc, key;
    var searchBlock = undefined;
    var sourceLanguage;

    breakme: {
        if (!extensionAPI.settings.get("dt-rAPI-key")) {
            key = "API";
            sendConfigAlert(key);
            break breakme;
        } else {
            rAPIkey = extensionAPI.settings.get("dt-rAPI-key");
            if (extensionAPI.settings.get("dt-lang")) {
                rAPIcc = extensionAPI.settings.get("dt-lang");
            } else {
                rAPIcc = "en";
            }
        }
        var promptSource = false;
        if (extensionAPI.settings.get("dt-prompt") == true) {
            promptSource = true;
        }

        const headers = buildHeaders(rAPIkey);

        if (parentOnly) { // translate focused block only
            searchBlock = await window.roamAlphaAPI.ui.getFocusedBlock()?.["block-uid"];
            if (searchBlock == undefined) {
                key = "focus";
                sendConfigAlert(key);
                break breakme;
            }
            let q = `[:find (pull ?page [:block/string :block/uid {:block/children ...}]) :where [?page :block/uid "${searchBlock}"]  ]`;
            var searchBlockInfo = await window.roamAlphaAPI.q(q);
            var searchString = searchBlockInfo[0][0].string;
            searchString = searchString.replace(/[\r\n]/gm, '');
            const protectedText = protectMarkup(searchString);
            var thisBlock = window.roamAlphaAPI.util.generateUID();
            await window.roamAlphaAPI.createBlock({
                location: { "parent-uid": searchBlock, order: 1 },
                block: { string: "detecting language...".toString(), uid: thisBlock }
            });

            if (promptSource == true) {
                sourceLanguage = await prompt();
                if (!sourceLanguage || sourceLanguage.trim() === "" || sourceLanguage == "null") {
                    await window.roamAlphaAPI.deleteBlock({ block: { uid: thisBlock } });
                } else {
                    sourceLanguage = sourceLanguage.trim();
                    await getTranslation(sourceLanguage, thisBlock, protectedText.text, rAPIcc, headers, protectedText.map);
                }
            } else {
                var raw = JSON.stringify({ q: protectedText.text });
                var requestOptions = {
                    method: 'POST',
                    headers,
                    body: raw,
                    redirect: 'follow'
                };

                await fetchWithRetry("https://deep-translate1.p.rapidapi.com/language/translate/v2/detect", requestOptions)
                    .then(response => {
                        if (!response.ok) {
                            throw new Error(`Detect failed: HTTP ${response.status}`);
                        }
                        return response.json();
                    })
                    .then(result => {
                        const detected = result?.data?.detections?.[0]?.language;
                        if (!detected) {
                            throw new Error("Detect failed: no language in response");
                        }
                        return getTranslation(detected, thisBlock, protectedText.text, rAPIcc, headers, protectedText.map);
                    })
                    .catch(async error => {
                        await setErrorBlock(thisBlock, error?.message || "Detect failed");
                    });
            }
        } else { // translate each child block
            var parentBlock = await window.roamAlphaAPI.ui.getFocusedBlock()?.["block-uid"];
            if (parentBlock == undefined) {
                key = "focus";
                sendConfigAlert(key);
                break breakme;
            }
            let q = `[:find (pull ?page [:block/string :block/uid :block/order {:block/children ...}]) :where [?page :block/uid "${parentBlock}"]  ]`;
            var parentBlockInfo = await window.roamAlphaAPI.q(q);

            if (parentBlockInfo[0][0].hasOwnProperty("children")) {
                parentBlockInfo[0][0].children = await sortObjectsByOrder(parentBlockInfo[0][0].children); // sort by order
                for (var i = 0; i < parentBlockInfo[0][0].children.length; i++) {
                    var searchString = parentBlockInfo[0][0].children[i].string;
                    searchString = searchString.replace(/[\r\n]/gm, '');
                    const protectedText = protectMarkup(searchString);
                    searchBlock = parentBlockInfo[0][0].children[i].uid;
                    var thisBlock = window.roamAlphaAPI.util.generateUID();

                    if (oneLang) { // only run language detect once, save api calls
                        var language;
                        if (i == 0) {
                            await window.roamAlphaAPI.createBlock({
                                location: { "parent-uid": searchBlock, order: 1 },
                                block: { string: "detecting language...".toString(), uid: thisBlock }
                            });

                            if (promptSource == true) {
                                sourceLanguage = await prompt();
                                if (!sourceLanguage || sourceLanguage.trim() === "" || sourceLanguage == "null") {
                                    await window.roamAlphaAPI.deleteBlock({ block: { uid: thisBlock } });
                                } else {
                                    sourceLanguage = sourceLanguage.trim();
                                    await getTranslation(sourceLanguage, thisBlock, protectedText.text, rAPIcc, headers, protectedText.map);
                                }
                            } else {
                                var raw = JSON.stringify({ q: protectedText.text });
                                var requestOptions = {
                                    method: 'POST',
                                    headers,
                                    body: raw,
                                    redirect: 'follow'
                                };

                                await fetchWithRetry("https://deep-translate1.p.rapidapi.com/language/translate/v2/detect", requestOptions)
                                    .then(response => {
                                        if (!response.ok) {
                                            throw new Error(`Detect failed: HTTP ${response.status}`);
                                        }
                                        return response.json();
                                    })
                                    .then(result => {
                                        language = result?.data?.detections?.[0]?.language;
                                        if (!language) {
                                            throw new Error("Detect failed: no language in response");
                                        }
                                        sourceLanguage = language;
                                        return getTranslation(language, thisBlock, protectedText.text, rAPIcc, headers, protectedText.map);
                                    })
                                    .catch(async error => {
                                        await setErrorBlock(thisBlock, error?.message || "Detect failed");
                                        sourceLanguage = null;
                                    });
                            }
                        } else {
                            if (!sourceLanguage) {
                                await setErrorBlock(thisBlock, "Detect failed: no source language");
                                continue;
                            }
                            await window.roamAlphaAPI.createBlock({
                                location: { "parent-uid": searchBlock, order: 1 },
                                block: { string: "translating text...".toString(), uid: thisBlock }
                            });
                            await getTranslation(sourceLanguage, thisBlock, protectedText.text, rAPIcc, headers, protectedText.map);
                        }
                    } else { // run detect on every child block
                        await window.roamAlphaAPI.createBlock({
                            location: { "parent-uid": searchBlock, order: 1 },
                            block: { string: "detecting language...".toString(), uid: thisBlock }
                        });

                        if (promptSource == true) {
                            sourceLanguage = await prompt();
                            if (!sourceLanguage || sourceLanguage.trim() === "" || sourceLanguage == "null") {
                                await window.roamAlphaAPI.deleteBlock({ block: { uid: thisBlock } });
                            } else {
                                sourceLanguage = sourceLanguage.trim();
                                await getTranslation(sourceLanguage, thisBlock, protectedText.text, rAPIcc, headers, protectedText.map);
                            }
                        } else {
                            var raw = JSON.stringify({ q: protectedText.text });
                            var requestOptions = {
                                method: 'POST',
                                headers,
                                body: raw,
                                redirect: 'follow'
                            };

                            await fetchWithRetry("https://deep-translate1.p.rapidapi.com/language/translate/v2/detect", requestOptions)
                                .then(response => {
                                    if (!response.ok) {
                                        throw new Error(`Detect failed: HTTP ${response.status}`);
                                    }
                                    return response.json();
                                })
                                .then(result => {
                                    const detected = result?.data?.detections?.[0]?.language;
                                    if (!detected) {
                                        throw new Error("Detect failed: no language in response");
                                    }
                                    return getTranslation(detected, thisBlock, protectedText.text, rAPIcc, headers, protectedText.map);
                                })
                                .catch(async error => {
                                    await setErrorBlock(thisBlock, error?.message || "Detect failed");
                                });
                        }
                    }
                }
            } else {
            }
        }
    }
}

async function getTranslation(language, uid, searchString, targetLanguage, headers, restoreMap) {
    await window.roamAlphaAPI.updateBlock(
        { block: { uid: uid, string: "translating text from __" + language + "__", open: true } });

    var rawText = JSON.stringify({ q: searchString, source: language, target: targetLanguage });
    var requestOptions1 = {
        method: 'POST',
        headers,
        body: rawText,
        redirect: 'follow'
    };

    await fetchWithRetry("https://deep-translate1.p.rapidapi.com/language/translate/v2", requestOptions1)
        .then(response => {
            if (!response.ok) {
                throw new Error(`Translate failed: HTTP ${response.status}`);
            }
            return response.json();
        })
        .then(result => {
            if (!result.hasOwnProperty("message")) {
                const translated = restoreMap ? restoreMarkup(result.data.translations.translatedText.toString(), restoreMap) : result.data.translations.translatedText.toString();
                window.roamAlphaAPI.updateBlock(
                    { block: { uid: uid, string: translated, open: true } });
            } else {
                return setErrorBlock(uid, "Too many api calls");
            }
        })
        .catch(async error => {
            await setErrorBlock(uid, error?.message || "Translate failed");
        });
}

async function prompt() {
    return new Promise((resolve) => {
        iziToast.question({
            theme: 'light',
            color: 'black',
            layout: 2,
            drag: true,
            class: "translate-toast",
            timeout: false,
            close: true,
            overlay: true,
            displayMode: 2,
            id: "question",
            title: "Translate",
            message: "From which language do you wish to translate? (two-letter language code)",
            position: "center",
            inputs: [
                [
                    '<input type="text" placeholder="">',
                    "keyup",
                    function (instance, toast, input, e) {
                        if (e.code === "Enter") {
                            instance.hide({ transitionOut: "fadeOut" }, toast, "button");
                            resolve(e.srcElement.value);
                        }
                    },
                    true,
                ],
            ],
            buttons: [
                [
                    "<button><b>Confirm</b></button>",
                    async function (instance, toast, button, e, inputs) {
                        instance.hide({ transitionOut: "fadeOut" }, toast, "button");
                        resolve(inputs[0].value);
                    },
                    false,
                ],
                [
                    "<button>Cancel</button>",
                    async function (instance, toast, button, e) {
                        instance.hide({ transitionOut: "fadeOut" }, toast, "button");
                        resolve("null");
                    },
                ],
            ],
            onClosing: function (instance, toast, closedBy) { },
            onClosed: function (instance, toast, closedBy) { },
        });
    })
}

function sendConfigAlert(key) {
    if (key == "API") {
        alert("Please set your RapidAPI Key in the configuration settings via the Roam Depot tab.");
    } else if (key == "focus") {
        alert("Please make sure to focus your cursor in the block containing the text you wish to translate.");
    }
}

async function sortObjectsByOrder(o) {
    return o.sort(function (a, b) {
        return a.order - b.order;
    });
}

async function setErrorBlock(uid, message) {
    try {
        await window.roamAlphaAPI.updateBlock({
            block: { uid, string: `error: ${message}`, open: true }
        });
    } catch (e) {
    }
}
