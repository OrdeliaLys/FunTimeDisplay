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

As silhouettes, images need a transparent background: a GIF with a solid background shows as a solid block. Keep animated images small (a few hundred pixels tall, a few MB) so they stay light on phones.
