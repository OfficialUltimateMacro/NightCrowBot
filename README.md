# Nightcrow Bot

Nightcrow Studios' Discord bot with a small, local OCR-based subscription-proof check.

## What it does

- Watches only the subscription-proof channel configured by `SUB_PROOF_CHANNEL_ID`.
- Reads one image attachment with Tesseract.js running inside the bot's Node.js process.
- Checks for the Nightcrow Studios channel name and a recognized subscribed-state label.
- Gives `FREE_ACCESS_ROLE_ID` only when both checks pass and Discord role permissions are correct.
- Replies in plain text and links accepted members to the free-products channel.
- Rejects byte-for-byte duplicate screenshots without deleting either upload.
- Does not moderate, delete, classify, or inspect messages outside the proof flow. Images stay in the channel, including when OCR fails or declines them.

OCR is a lightweight screening check, not proof that a screenshot is genuine or that a subscription is still active. A carefully edited image can fool text recognition. Keep staff review available for edge cases.

## Setup

1. Use Node.js 20 or newer.
2. Install production dependencies with `npm install --omit=dev`.
3. Copy `.env.example` to a private `.env` file or add these values in the host's environment-variable panel:
   - `DISCORD_TOKEN`: the bot token; keep it secret.
   - `CLIENT_ID`: the Discord application's ID.
   - `GUILD_ID`: the Nightcrow Discord server ID.
   - `SUB_PROOF_CHANNEL_ID`: the channel to monitor.
   - `FREE_ACCESS_ROLE_ID`: the role granted after a successful OCR match.
   - `FREE_PRODUCTS_CHANNEL_ID`: the destination channel linked in the success reply.
   - `OCR_LANGUAGES`: optional Tesseract language codes. Defaults to `eng+hin`.
4. In the Discord Developer Portal, enable Server Members Intent and Message Content Intent.
5. Give the bot View Channel, Read Message History, Send Messages, and Manage Roles in the proof channel. Put its role above Free Access in the server role list.
6. Start with `npm start`. Tesseract.js downloads the selected language data on first use and caches it under `data/ocr-cache`; the cache and duplicate-hash file are ignored by Git.

No separate OCR service, OCR URL, or OCR secret is required. The legacy `ocr-service/` folder is not used by this bot.

## Language and hosting notes

English and Hindi are loaded by default for the channel-name and common subscription labels. You can set `OCR_LANGUAGES` to other Tesseract language codes, such as `eng+spa` or `eng+fra`; language codes and label matching are not universal, so add and test the languages your community needs. Loading more languages uses additional memory and disk. The bot serializes image checks through one OCR worker to limit resource use. If the host runs out of memory, use fewer language models or allocate more RAM.

Tesseract only reads visible text. It is not an NSFW filter, image-authenticity detector, or subscription API. This bot intentionally does not delete messages; use a separate moderation bot if you want moderation.

## Persistent files

- `data/proof-hashes.json`: exact image hashes used to prevent identical file re-uploads.
- `data/ocr-cache/`: cached Tesseract language data.

Back up `data/` if you want duplicate protection to survive host migrations. Do not share the bot token or commit secrets.

## License and attribution

Copyright (c) Nightcrow Studios. All rights reserved.

This repository's original bot code is provided for use in the Nightcrow Studios Discord server. Do not redistribute, resell, sublicense, or publish copies of the bot without written permission from Nightcrow Studios. Tesseract.js and its trained language data are third-party components with their own licenses; retain their notices and follow their respective terms. This notice does not change the license of third-party Roblox models, scripts, audio, fonts, or other assets.
