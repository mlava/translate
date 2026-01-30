import iziToast from "izitoast";
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const DEFAULT_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 500;

function buildHeaders(rAPIkey) {
    const headers = new Headers();
    headers.set("X-RapidAPI-Key", rAPIkey);
    headers.set("X-RapidAPI-Host", "deep-translate1.p.rapidapi.com");
    headers.set("Content-Type", "text/plain");
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
            warn("retrying request", { url, status: response.status, attempt: attempt + 1, delayMs: delay });
            await sleep(delay);
            attempt += 1;
        } catch (err) {
            if (attempt >= retries) {
                throw err;
            }
            const delay = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * baseDelayMs);
            warn("retrying request after network error", { url, attempt: attempt + 1, delayMs: delay });
            await sleep(delay);
            attempt += 1;
        }
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
                if (sourceLanguage == "null") {
                    await window.roamAlphaAPI.deleteBlock({ block: { uid: thisBlock } });
                } else {
                    await getTranslation(sourceLanguage, thisBlock, protectedText.text, rAPIcc, headers, protectedText.map);
                }
            } else {
                var raw = "{\"q\": \"" + protectedText.text + "\"}";
                var requestOptions = {
                    method: 'POST',
                    headers,
                    body: raw,
                    redirect: 'follow'
                };

                fetchWithRetry("https://deep-translate1.p.rapidapi.com/language/translate/v2/detect", requestOptions)
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
                                if (sourceLanguage == "null") {
                                    await window.roamAlphaAPI.deleteBlock({ block: { uid: thisBlock } });
                                } else {
                                    await getTranslation(sourceLanguage, thisBlock, protectedText.text, rAPIcc, headers, protectedText.map);
                                }
                            } else {
                                var raw = "{\"q\": \"" + protectedText.text + "\"}";
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
                                    });
                            }
                        } else {
                            await window.roamAlphaAPI.createBlock({
                                location: { "parent-uid": searchBlock, order: 1 },
                                block: { string: "translating text...".toString(), uid: thisBlock }
                            });
                            await getTranslation(sourceLanguage, thisBlock, protectedText.text, rAPIcc, headers, protectedText.map);
                        }
                    } else { // run detect on every child block
                        window.roamAlphaAPI.createBlock({
                            location: { "parent-uid": searchBlock, order: 1 },
                            block: { string: "detecting language...".toString(), uid: thisBlock }
                        });

                        if (promptSource == true) {
                            sourceLanguage = await prompt();
                            if (sourceLanguage == "null") {
                                await window.roamAlphaAPI.deleteBlock({ block: { uid: thisBlock } });
                            } else {
                                await getTranslation(sourceLanguage, thisBlock, protectedText.text, rAPIcc, headers, protectedText.map);
                            }
                        } else {
                            var raw = "{\"q\": \"" + protectedText.text + "\"}";
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

    var rawText = "{\"q\": \"" + searchString + "\", \"source\":\"" + language + "\",\"target\":\"" + targetLanguage + "\"}";
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
                alert("Too many api calls");
                window.roamAlphaAPI.deleteBlock(
                    { block: { uid: uid } });
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
