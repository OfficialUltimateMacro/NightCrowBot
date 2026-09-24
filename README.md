# Nightcrow Bot

Nightcrow Studios' Discord automation bot.

## Subscription proof protection

The bot watches only channel `1551744713688621126`.

- Checks image attachments with a local Tesseract.js OCR worker for the Nightcrow channel name and a subscribed-state label.
- Supports common localized YouTube UI labels and light/dark themes. OCR cannot detect NSFW or prove a screenshot is unedited, so a separate NSFW classifier is still needed before opening verification widely.
- Gives role `1551747469455654963` only after a clear accepted review.
- Links verified members directly to `#free-products` (`1551745615761768569`).
- Saves a SHA-256 fingerprint of every accepted image. An exact re-upload by anyone is rejected.
- Leaves submitted images in place and replies with a compact Nightcrow status message.

An exact-file hash cannot detect a resized, cropped, or edited copy. A screenshot is also never absolute proof of subscription; staff should treat the automation as strict screening, not perfect fraud prevention.

## Support tickets and server information

When the bot starts, it creates or updates compact Nightcrow embeds in the rules channel (`1551745881819054090`), support channel (`1551744887739654245`), free-access channel (`1551741541071196311`), and how-to-buy channel (`1551745010226036816`). Each managed post is matched by its footer and updated in place on later starts.

The selector opens a numbered private channel under category `1552112181343031326`. The ticket opener, bot, and server owner can see it; the opener can send messages and attach files. The opening post pings `@here`, the owner, and the opener. The opener or owner can close a ticket; closing locks the opener from sending while preserving the conversation.

Crow needs View Channel, Read Message History, Send Messages, Embed Links, Manage Roles, and **Manage Channels**. Manage Channels is a server-level permission, so it also lets Crow create, edit, and delete other server channels. Without it, the bot will leave the panel visible but ticket creation will return a setup warning. Keep the Crow role trusted and do not grant Administrator just for tickets.

Ticket numbers persist in `data/ticket-state.json`. The bot-managed posts are identified by their embed footer and updated in place on later starts.

## Required environment variables

Add the bot token in the **Nightcrow Bot** Apollo server's Variables page; never commit it.

```text
DISCORD_TOKEN=your Discord bot token
```

Optional overrides include `OCR_LANGUAGES`, `SUB_PROOF_CHANNEL_ID`, `FREE_ACCESS_ROLE_ID`, `FREE_PRODUCTS_CHANNEL_ID`, `FREE_ACCESS_INFO_CHANNEL_ID`, `HOW_TO_BUY_CHANNEL_ID`, `SUPPORT_CHANNEL_ID`, `RULES_CHANNEL_ID`, and `TICKET_CATEGORY_ID`. The defaults match Nightcrow Studios.

## Whop checkout setup

Add `WHOP_API_KEY` as a private variable in the Nightcrow Bot host. Never put it in the website, a committed file, or Discord. The key must be allowed to create account products, one-time plans, and promo codes. `WHOP_ACCOUNT_ID` defaults to `biz_0bsVpFW750nDlH`; change it only if you sell through a different Whop business. `WHOP_API_VERSION_DATE` is optional and defaults to `2026-09-23`.

## Discord setup

Enable **Server Members Intent** and **Message Content Intent** in Discord Developer Portal → Bot. Give the bot View Channel, Read Message History, Send Messages, Embed Links, Attach Files, Manage Roles, and Manage Channels. Move its role above **Free Products Access** in the server role list.

## Product commands

The server owner or a member with **Manage Server** can use `/product create` to fill out a private, two-step listing form. It collects the name, category, one-time USD price, summary, full description, features, included files, optional HTTPS cover image, and product-specific license notes. Crow shows an ephemeral preview. Only after **Publish product** is pressed does the bot create a Whop product and one-time plan, then store Whop's returned secure checkout URL in the website catalog.

Publishing updates `catalog.json` in the Night Crow Studios website repository and announces the new product in the `product-updates` channel. `/product update` publishes product notes to the site feed and Discord; `/product remove` archives the listing while retaining its history. The host needs a `GITHUB_TOKEN` private variable backed by a fine-grained token scoped to `OfficialUltimateMacro/NIGHTCROW_STUDIOS` with **Contents: Read and write**. Set it only in the bot host's environment settings; never send or commit the token. Optional configuration: `STOREFRONT_REPOSITORY`, `STOREFRONT_BRANCH`, `STOREFRONT_CATALOG_PATH`, `STOREFRONT_URL`, `PRODUCT_UPDATES_CHANNEL_ID`, and `GUILD_ID`.

The first publish also attempts to create the account-wide `EASYMONEY` promotion for 5% off, limited to one use per customer, so it can be used with products added later. If Whop reports that the code already exists or the API key lacks promo permissions, Crow will still publish the checkout and tell you to verify the existing code's discount and product scope in Whop. Product and plan requests use stable idempotency keys so retries reuse the same Whop resources. If a catalog commit fails after checkout creation, retry **Publish product** on the same draft to finish the website update. Website deployment runs through the repository's Cloudflare Pages integration.

