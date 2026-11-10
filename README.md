# piksel-maskot

> **Current status: not working yet.** The robot does not appear in current versions of the Claude desktop app, because this app version does not draw the mod backdrop layer it relies on. A different approach is in progress.

A small 3D robot for the Claude Code desktop app. It stands on top of the message box: while Claude is idle it bounces a tennis ball on its racket, and while Claude works it types on a laptop.

The robot is drawn as animated SVG from a small 3D box model, with flat colors. If your system asks for reduced motion, it stands still.

## Install

At the prompt of a terminal session:

`/plugin install piksel-maskot --marketplace Hakanynyrt/piksel-maskot`

From a shell:

`claude plugin install piksel-maskot --marketplace Hakanynyrt/piksel-maskot`

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `Hakanynyrt/piksel-maskot`, then Add plugin.

Restart the app after installing.

## Good to know

- It only draws in the Claude Code tab of the desktop app. The terminal, VS Code and the mobile app do not show it.
- It uses the desktop app's backdrop layer and makes the panels over it transparent, with a dark or light background chosen from your system theme.
- Its position is computed for the default layout, with the left sidebar open. Closing the sidebar moves the robot away from the message box. You can adjust `SIDEBAR_SHIFT_PX`, `COMPOSER_HALF_WIDTH_PX` and `COMPOSER_TOP_FROM_BOTTOM_PX` in `hooks/register.tsx`.
- The mod API it is built on is in early access and may change between Claude Code releases.

This is an independent community project and is not affiliated with or endorsed by Anthropic.

## License

MIT
