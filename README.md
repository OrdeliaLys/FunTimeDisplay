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
- **Needs status effect**: SillyStatus effects, separated by commas, all of which must be active. Match by name or icon, add `>=N` for a minimum stage, and use `|` for either-or, like `Fox ears|🦊, Hypnosis>=4`.

Labels whose conditions aren't met are hidden from the AI. Labels whose conditions are met are marked as special, so the AI prefers them over a general label for the same action. When a special label stops applying, the general one with the same base name takes over (`Blowjob (ears)` falls back to `Blowjob`). Each label shows whether its conditions are met right now. Needs SillyStatus 1.8.1 or newer for status effect conditions.
