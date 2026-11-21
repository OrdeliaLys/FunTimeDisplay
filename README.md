# FunTimeDisplay (Scene Backdrop)

A SillyTavern extension that shows one of your own images behind the chat messages, chosen to match what's happening in the scene. Images can be shown as a plain silhouette in any colour. Built with mobile in mind.

## Install

In SillyTavern: **Extensions** (cubes icon) → **Install extension** → paste:

```
https://github.com/OrdeliaLys/FunTimeDisplay
```

Then reload the page.

## Use

1. Open **Extensions → Scene Backdrop** and give each label an image with the **Image** button. Images are saved in SillyTavern's own storage. Rename labels, add hints for the AI, or add more labels as you like.
2. In a chat, open the **wand menu** next to the message box and tap **Scene backdrop** to turn it on for that chat. It's off by default everywhere (or turn on "On in every chat" in settings).
3. After each character reply, a short AI request picks the label that fits best and the image fades in behind the messages. Picks are saved per swipe.

**Show** previews an image, **Use now** sets it by hand, **Pick now** re-runs the pick, and **Clear** removes the current image.

## Images

As silhouettes, images need a transparent background: a GIF with a solid background shows as a solid block.

New images are cleaned up when you upload them: every frame is turned into a crisp solid shape, small holes left by background-removal tools are filled, and stray specks are removed. The frames are stored as one sheet the extension plays itself. Images uploaded before this existed can be cleaned with the **Clean up** button. With **Position: Automatic**, a figure that's cut off at the bottom of its image is pinned to the bottom of the chat so the cut edge stays off-screen.

The **Edge glow** adds a soft halo around the outline so a black silhouette stays visible on a dark chat.

## Conditions

Each label can have optional conditions, checked by the extension itself:

- **Only with**: character names, separated by commas. Met when any of them is in the chat (the character card or a group member) or is named in the recent messages.
- **Needs trait or effect**: items separated by commas, all of which must be true. Each item is met by a trait, meaning the word or phrase appears on a character card in the chat (description, personality, scenario or tags), in your persona description or in the recent messages, like `kitsune` or `fox ears`. It is also met by an active SillyStatus effect, matched by name or icon, with `>=N` for a minimum stage. Use `|` for either-or, like `fox ears|kitsune, Hypnosis>=4`. Words match whole, so add plurals as alternatives if you need them (`kitsune|kitsunes`).

Labels whose conditions aren't met are hidden from the AI. Labels whose conditions are met are marked as special, so the AI prefers them over a general label for the same action. When a special label stops applying, the general one with the same base name takes over (`Blowjob (ears)` falls back to `Blowjob`). Each label shows whether its conditions are met right now. Status effect conditions need SillyStatus 1.8.1 or newer.

**AI confirms traits** (on by default, per label): a trait found as a word could be backstory ("her grandmother was a kitsune"), a form the character isn't in right now, or something that has changed since. With this on, the AI checks it as part of its normal pick, so there's no extra request. When the trait came from a card or your persona, only a short snippet around the word is sent along. Traits satisfied by a SillyStatus effect don't need confirming. Turn it off for labels whose traits are always literally true, to keep picks as small as possible.

### Special versions and plain-language conditions

A label with conditions whose name contains a general label's name is treated as that label's special version: `Kemono Handjob` and `Handjob (ears)` are special versions of `Handjob`. The AI picks the action from the general labels, and the extension switches to the special version itself when it applies. That happens automatically when the condition is certain (a SillyStatus effect, or AI confirmation turned off), or when the AI confirms the condition is true right now.

The **Needs** field also takes a plain description, like `Any perky animal ears (cat, fox, dog, horse, tanuki girls, for example)`. The extension uses its notable words to check whether anyone in the scene might qualify and to find the relevant card snippets, and the AI judges the description itself.
