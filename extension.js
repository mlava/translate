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
    ]
};

export default {
    onload: ({ extensionAPI }) => {
        extensionAPI.settings.panel.create(config);

        window.roamAlphaAPI.ui.commandPalette.addCommand({
            label: "Translate using Deep Translate (Current block)",
            callback: () => getTrans({ extensionAPI }, true, false)
        });
        window.roamAlphaAPI.ui.commandPalette.addCommand({
            label: "Translate using Deep Translate (All Child blocks, Same language)",
            callback: () => getTrans({ extensionAPI }, false, true)
        });
        window.roamAlphaAPI.ui.commandPalette.addCommand({
            label: "Translate using Deep Translate (All Child blocks, Multiple languages)",
            callback: () => getTrans({ extensionAPI }, false, false)
        });
    },
    onunload: () => {
        window.roamAlphaAPI.ui.commandPalette.removeCommand({
            label: 'Translate using Deep Translate (Current block)'
        });
        window.roamAlphaAPI.ui.commandPalette.removeCommand({
            label: 'Translate using Deep Translate (All Child blocks, Same language)'
        });
        window.roamAlphaAPI.ui.commandPalette.removeCommand({
            label: 'Translate using Deep Translate (All Child blocks, Multiple languages)'
        });
    }
}

async function getTrans({ extensionAPI }, parentOnly, oneLang) {
    var rAPIkey, rAPIcc, key;
    var searchBlock = undefined;
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

        var myHeaders = new Headers();
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
            window.roamAlphaAPI.createBlock({
                location: { "parent-uid": searchBlock, order: 1 },
                block: { string: "detecting language...".toString(), uid: thisBlock }
            });

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
                    getTranslation(result.data.detections[0].language);
                })
                .catch(error => console.log('error', error));

            async function getTranslation(language) {
                window.roamAlphaAPI.updateBlock(
                    { block: { uid: thisBlock, string: "translating text from __" + language + "__", open: true } });
                var rawText = "{\"q\": \"" + searchString + "\", \"source\":\"" + language + "\",\"target\":\"en\"}";

                var requestOptions1 = {
                    method: 'POST',
                    headers: myHeaders,
                    body: rawText,
                    redirect: 'follow'
                };

                fetch("https://deep-translate1.p.rapidapi.com/language/translate/v2", requestOptions1)
                    .then(response => response.json())
                    .then(result => {
                        window.roamAlphaAPI.updateBlock(
                            { block: { uid: thisBlock, string: result.data.translations.translatedText.toString(), open: true } });
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
                            window.roamAlphaAPI.createBlock({
                                location: { "parent-uid": searchBlock, order: 1 },
                                block: { string: "detecting language...".toString(), uid: thisBlock }
                            });

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
                                    return getTranslation(language);
                                })
                                .catch(error => console.log('error', error));
                        } else {
                            window.roamAlphaAPI.createBlock({
                                location: { "parent-uid": searchBlock, order: 1 },
                                block: { string: "translating text...".toString(), uid: thisBlock }
                            });
                            await getTranslation(language);
                        }                      

                        async function getTranslation(language) {
                            window.roamAlphaAPI.updateBlock(
                                { block: { uid: thisBlock, string: "translating text...", open: true } });

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
                                    window.roamAlphaAPI.updateBlock(
                                        { block: { uid: thisBlock, string: result.data.translations.translatedText.toString(), open: true } });
                                })
                                .catch(error => console.log('error', error));
                        }
                    } else { // run detect on every child block
                        window.roamAlphaAPI.createBlock({
                            location: { "parent-uid": searchBlock, order: 1 },
                            block: { string: "detecting language...".toString(), uid: thisBlock }
                        });
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
                                return getTranslation(result.data.detections[0].language);
                            })
                            .catch(error => console.log('error', error));

                        async function getTranslation(language) {
                            window.roamAlphaAPI.updateBlock(
                                { block: { uid: thisBlock, string: "translating text...", open: true } });
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
                                    window.roamAlphaAPI.updateBlock(
                                        { block: { uid: thisBlock, string: result.data.translations.translatedText.toString(), open: true } });
                                })
                                .catch(error => console.log('error', error));
                        }
                    }
                }
            }
        }
    }
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