# Nightcrow Bot

Nightcrow Studios' Discord automation bot.

## Subscription proof protection

The bot watches only channel `1551744713688621126`.

- Deletes posts containing text, links, extra files, non-images, or more than one attachment.
- Rejects NSFW, unrelated, unclear, non-YouTube, wrong-channel, and non-subscribed screenshots through strict vision review.
- Supports localized YouTube UI and light/dark themes.
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
OPENAI_API_KEY=your OpenAI API key for image review
OPENAI_MODEL=gpt-4.1-mini
```

The bot deliberately will not grant roles until `OPENAI_API_KEY` is configured. Enabling it sends submitted proof images to OpenAI for review and may incur API charges—get a guardian's approval before enabling it.

## Discord setup

Enable **Server Members Intent** and **Message Content Intent** in Discord Developer Portal → Bot. Give the bot View Channel, Read Message History, Send Messages, Embed Links, Manage Messages, and Manage Roles. Move its role above **Free Access** in the server role list.
