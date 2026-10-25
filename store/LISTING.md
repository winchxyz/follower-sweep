# Chrome Web Store listing for Sweep

Paste these into the Developer Dashboard. Files are in this folder; build them with
`SHOT_HEIGHT=800 npm run e2e`, then `node tools/build-store.mjs` (both need PLAYWRIGHT_CORE).

## Package
- Upload: `store/sweep-store.zip` (the manifest has no `key`; the store gives Sweep its own ID)

## Store listing tab
- **Name** (from the manifest): Sweep: follower cleanup for X
- **Summary** (from the manifest): Finds followers without a checkmark and under 5,000 followers with the official X API, and marks them on your Followers page.
- **Category:** Social & Communication
- **Language:** English
- **Icon:** extension/icons/128.png (already in the package)
- **Screenshots** (1280x800): screenshot-1 … screenshot-5
- **Small promo tile** (440x280): promo-small.png
- **Marquee promo tile** (1400x560, optional): promo-marquee.png
- **Homepage URL:** https://winchxyz.github.io/follower-sweep/
- **Support URL:** https://github.com/winchxyz/follower-sweep/issues

### Description
```
Clean dead followers off your X account without breaking X's rules.

Sweep reads your followers through the official X API, works out who looks dead, and marks them right on your Followers page. You remove them with X's own menu: X bans tools that click on x.com for you, so Sweep never does.

WHAT IT DOES
• Scans every follower: checkmark, follower count, posts, and the date of their last post.
• Keep rules you control: keep checkmarks (X Premium, business, government), accounts with 5,000+ followers, people you follow, subscribers, and anyone you pick by hand.
• "Only remove accounts silent for N days", with a live count.
• Sorts the deadest first: no posts, default avatar, no bio, silent for a year, follows thousands with no followers.
• Marks every row on your Followers page red (remove) or green (keep), with the reason.
• One by one mode: opens profiles in order and notices when "Follows you" disappears.
• Following side: who doesn't follow you back, with the same rules, marked on your Following page.
• Re-scan to confirm, and export everything to CSV.
• Sample mode to try it without an X account.

WHAT YOU NEED
Your own X developer app (console.x.com). X bills the API reads to it directly: about $1 per 1,000 followers. Sweep shows the price before every scan, and a second scan on the same UTC day is free.

PRIVATE BY DESIGN
No server, no account, no analytics. Everything stays in your browser. Open source (MIT): https://github.com/winchxyz/follower-sweep

Not affiliated with X Corp.
```

## Privacy practices tab
- **Single purpose:** Helps you review your own X followers and the accounts you follow, and mark the ones to remove or unfollow.
- **Permission justifications**
  - `storage`: Saves your scan, keep rules and marks in the browser.
  - `unlimitedStorage`: A scan of a large account (tens of thousands of followers) is bigger than the default storage quota.
  - `identity`: Runs the "Sign in with X" OAuth window (chrome.identity.launchWebAuthFlow).
  - Host permission `https://api.x.com/*`: Reads your followers and the accounts you follow through the official X API.
  - Content script on `https://x.com/*`: Adds Remove/Keep labels to the rows of your Followers and Following pages and a bar on profiles. It only reads handles on the page; it never clicks or types.
- **Remote code:** No, I am not using remote code.
- **Data usage:** tick "Personally identifiable information" (X handles and names) and "Authentication information" (the X sign-in token). Then tick all three certifications: not sold, not used for unrelated purposes, not used for creditworthiness.
- **Privacy policy URL:** https://winchxyz.github.io/follower-sweep/privacy.html

## Distribution tab
- **Visibility:** Public
- **Regions:** All regions
- **Price:** Free
