If you've ever wanted to translate blocks of text within your Roam Research graph, this extension makes it possible. The extension will check determine the language of the text and then translate it from that language to your preferred language (set in Roam Depot settings).

The translation will be placed in a newly created child block to the source.

This video walks through the options:

https://www.loom.com/share/2166ef87a8464af9b48deba226ed3d00

You can trigger the extension by:
- focusing in a block you want to translate, then opening Command Palette and selecting __Translate using Deep Translate (Current block)__.
- focusing on a block that has child blocks you want to translate in bulk. Then choose either __Translate using Deep Translate (All Child blocks, Same language)__ which detects the language from the first child block and then uses that language for all subsequent child blocks.
- Alternatively, choose __Translate using Deep Translate (All Child blocks, Multiple languages)__ which will mean that language detection runs on each child block independently and then translation occurs based on that language detection.

You will need an API key from https://rapidapi.com/gatzuma/api/deep-translate1. This API translates over 100 languages, and allows for translation of 100,000 characters / month. It doesn't require a credit card to sign up, as it just stops working if you exceed the character count. You can pay for higher volumes if you do a lot of translating in your graph.

TODO:
1. handle text containing links and any other markdown that causes translation to fail
