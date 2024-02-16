import iziToast from "izitoast";
var myHeaders = new Headers();

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
            callback: () => getTrans({ extensionAPI }, true, false)
        });
        extensionAPI.ui.commandPalette.addCommand({
            label: "Translate using Deep Translate (All Child blocks, Same language)",
            callback: () => getTrans({ extensionAPI }, false, true)
        });
        extensionAPI.ui.commandPalette.addCommand({
            label: "Translate using Deep Translate (All Child blocks, Multiple languages)",
            callback: () => getTrans({ extensionAPI }, false, false)
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

        myHeaders.append("X-RapidAPI-Key", rAPIkey);
        myHeaders.append("X-RapidAPI-Host", "deep-translate1.p.rapidapi.com");
        myHeaders.append("Content-Type", "text/plain");

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
                    await getTranslation(sourceLanguage, thisBlock, searchString);
                }
            } else {
                var raw = "{\"q\": \"" + searchString + "\"}";
                var requestOptions = {
                    method: 'POST',
                    headers: myHeaders,
                    body: raw,
                    redirect: 'follow'
                };

                fetch("https://deep-translate1.p.rapidapi.com/language/translate/v2/detect", requestOptions)
                    .then(response => response.json())
                    .then(result => {
                        return getTranslation(result.data.detections[0].language, thisBlock, searchString);
                    })
                    .catch(error => console.log('error', error));
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
                                    await getTranslation(sourceLanguage, thisBlock, searchString);
                                }
                            } else {
                                var raw = "{\"q\": \"" + searchString + "\"}";
                                var requestOptions = {
                                    method: 'POST',
                                    headers: myHeaders,
                                    body: raw,
                                    redirect: 'follow'
                                };

                                await fetch("https://deep-translate1.p.rapidapi.com/language/translate/v2/detect", requestOptions)
                                    .then(response => response.json())
                                    .then(result => {
                                        language = result.data.detections[0].language;
                                        return getTranslation(language, thisBlock, searchString);
                                    })
                                    .catch(error => console.log('error', error));
                            }
                        } else {
                            await window.roamAlphaAPI.createBlock({
                                location: { "parent-uid": searchBlock, order: 1 },
                                block: { string: "translating text...".toString(), uid: thisBlock }
                            });
                            await getTranslation(sourceLanguage, thisBlock, searchString);
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
                                await getTranslation(sourceLanguage, thisBlock, searchString);
                            }
                        } else {
                            var raw = "{\"q\": \"" + searchString + "\"}";
                            var requestOptions = {
                                method: 'POST',
                                headers: myHeaders,
                                body: raw,
                                redirect: 'follow'
                            };

                            await fetch("https://deep-translate1.p.rapidapi.com/language/translate/v2/detect", requestOptions)
                                .then(response => response.json())
                                .then(result => {
                                    return getTranslation(result.data.detections[0].language, thisBlock, searchString);
                                })
                                .catch(error => console.log('error', error));
                        }
                    }
                }
            }
        }
    }
}

async function getTranslation(language, uid, searchString) {
    await window.roamAlphaAPI.updateBlock(
        { block: { uid: uid, string: "translating text from __" + language + "__", open: true } });

    var rawText = "{\"q\": \"" + searchString + "\", \"source\":\"" + language + "\",\"target\":\"en\"}";
    var requestOptions1 = {
        method: 'POST',
        headers: myHeaders,
        body: rawText,
        redirect: 'follow'
    };

    await fetch("https://deep-translate1.p.rapidapi.com/language/translate/v2", requestOptions1)
        .then(response => response.json())
        .then(result => {
            if (!result.hasOwnProperty("message")) {
                window.roamAlphaAPI.updateBlock(
                    { block: { uid: uid, string: result.data.translations.translatedText.toString(), open: true } });
            } else {
                alert("Too many api calls");
                window.roamAlphaAPI.deleteBlock(
                    { block: { uid: uid } });
            }
        })
        .catch(error => console.log('error', error));
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