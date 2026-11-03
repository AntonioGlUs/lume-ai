# Lume AI

A friend beside you: describes the page you are on, out loud, with context.

## Load it in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose this folder.
4. Open the extension **Options** and add your own Anthropic API key
   (get one at [console.anthropic.com](https://console.anthropic.com)). Without a key, Lume only gives a basic
   description and cannot hold a conversation.

The key is stored only in your browser (`chrome.storage.local`). It is never part of this repository.
When you use the conversation, the content of the page you are on is sent to the Anthropic API.

## Use it

Press **Alt+Shift+L** on any page. Press it again while it is speaking to stop.
If the shortcut does not work, set it at `chrome://extensions/shortcuts`.

## Stages

1. Read the page and describe it out loud.
2. Voice input: Lume listens after describing and answers questions.
3. Actions: type, click, scroll, go back, and read the new page (this version).
   Lume refuses password, card and buy/pay controls: the user does those.
   Delete is allowed only on shopping cart pages.
4. Options, safety confirmations and polish.

## How it works

1. **Read.** `content.js` is injected into the active tab and returns a snapshot: title, headings, controls
   (each tagged with a `data-lume-id`), images and their alt text, the text on screen, scroll position and flags.
2. **Think.** `background.js` sends the snapshot and the conversation to Claude (Haiku 5.5 by default,
   Sonnet 5.5 optional) with the tools `click`, `type_text`, `scroll`, `go_back` and `read_more`.
3. **Act.** Tool calls run inside the page, then Lume reads the page again and tells the user the result.
4. **Talk.** The microphone runs in an offscreen document (service workers cannot listen).
   Speech uses the system voice through `chrome.tts`.

Only the newest snapshot is kept in the conversation to save tokens. Lume follows the active tab,
so a link that opens in a new tab keeps the conversation going.

## What Lume reads

- **Controls:** links, buttons, inputs, selects, text areas, `role=button|link|tab` and elements wired with
  `data-action`, `onclick` or `tabindex` (Amazon builds some buttons this way). Up to 90 on screen and 15 below.
  If the page has more, the snapshot is marked incomplete and Lume offers to search deeper (`read_more`, up to 200).
- **Text, headings and images:** only what is on screen now, so it changes after every scroll.
  Lume cannot see images, only their alt, `aria-label` or `title`.
- **Pop-ups:** a pop-up counts only if it blocks the page behind it: a modal `<dialog>`, a dialog that fills
  the screen, or one with a full-screen backdrop. Then Lume reads only what is inside it.
  Side panels that do not block the page (like Amazon's mini cart) are read with the page.

## Safety rules

- Lume never takes part in passwords, logins, card details or purchases. The user does those.
- Pages with password or card fields, or a URL with `checkout`, `payment`, `billing`, `login`, `signin`
  or `signup`, are marked sensitive. Clicking and typing are blocked there, in the page itself,
  whatever the model decides.
- Click labels such as buy, pay, checkout, place order, subscribe and log in are blocked.
  `delete` is allowed only when the URL contains `cart`, `basket`, `bag` or `carrito`.
- The value of password and card fields is never read.

## Options

Open the extension **Options** to set:

- Anthropic API key (stored only in this browser) and model.
- Language: English or Spanish.
- Voice and speed (premium voices from macOS Spoken Content sound more natural).
- Interruption: let the user interrupt by talking, with a sensitivity level
  (loud voice only, normal voice, any voice). Headphones work best.
- Microphone permission (needed once, from a visible page).

## Known limits and ideas

- Images without alt text cannot be described. A vision mode (screenshots) is planned.
- Only the main document is read: content inside iframes or shadow DOM is not seen.
- The system voice sounds robotic. An AI voice is planned.
- The API key is stored in the browser. A backend is planned before real users.

## Contributing

Contributions are welcome. Open an issue to discuss an idea or a bug, or send a pull request.
To test a change, edit the files and click the reload button of the extension in `chrome://extensions`.
Never commit an API key.

## License

[MIT](LICENSE)
