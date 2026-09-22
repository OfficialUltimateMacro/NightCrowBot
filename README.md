# Nightcrow Bot

Nightcrow Studios' Discord automation bot.

## Subscription proof protection

The bot watches only channel `1551744713688621126`.

- Deletes posts containing text, links, extra files, non-images, or more than one attachment.
- Uses a private local PP-OCRv4 service to read the Nightcrow channel and a localized subscribed-state label.
- Supports common localized YouTube UI labels and light/dark themes. OCR cannot detect NSFW or prove a screenshot is unedited, so a separate NSFW classifier is still needed before opening verification widely.
- Gives role `1551747469455654963` only after a clear accepted review.
- Links verified members directly to `#free-products` (`1551745615761768569`).
- Saves a SHA-256 fingerprint of every submitted image. An exact re-upload by anyone is deleted and rejected.
- Replies with a restrained black Nightcrow embed for every outcome.

An exact-file hash cannot detect a resized, cropped, or edited copy. A screenshot is also never absolute proof of subscription; staff should treat the automation as strict screening, not perfect fraud prevention.

## Required environment variables

Add these in the **Nightcrow Bot** Apollo server's Variables page; never commit them.

```text
DISCORD_TOKEN=your Discord bot token
CLIENT_ID=Discord Developer Portal → General Information → Application ID
GUILD_ID=right-click the Nightcrow Studios Discord server → Copy Server ID
OCR_SERVICE_URL=http://your-private-ocr-host:8000
OCR_SERVICE_SECRET=a-long-random-secret-shared-with-the-ocr-service
```

The bot deliberately will not grant roles until the private OCR service is configured. The submitted proof image is sent only to your OCR server.

## Local OCR service

Deploy `ocr-service/` to a separate Python-capable server. It needs at least 1 GB RAM and 2 GB disk during model installation and first load. See `ocr-service/README.md`.

## Discord setup

Enable **Server Members Intent** and **Message Content Intent** in Discord Developer Portal → Bot. Give the bot View Channel, Read Message History, Send Messages, Embed Links, Manage Messages, and Manage Roles. Move its role above **Free Access** in the server role list.
