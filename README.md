# piksel-maskot

A small 3D robot for the Claude desktop app on Windows. It stands on top of the message box in its own transparent window: while Claude is idle it bounces a tennis ball on its racket, and while Claude works it types on a laptop.

## Requirements

- Windows and the Claude desktop app
- Python 3 with tkinter, with `pythonw` or `pyw` available (the python.org installer includes both)

## Install

From a shell:

`claude plugin install piksel-maskot --marketplace Hakanynyrt/piksel-maskot`

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `Hakanynyrt/piksel-maskot`, then Add plugin.

Restart the app after installing. When a Claude Code session starts, the mod launches the robot window with Python. Only one robot runs at a time.

## Using it

- Drag the robot to fine-tune its position. The position is remembered.
- Right-click the robot to reset its position or close it.
- It follows the Claude window, hides when Claude is minimized, and stays behind other apps that cover Claude.

## Good to know

- The default position assumes the left sidebar is open. If you close the sidebar, drag the robot to the message box.
- Sessions that started before the install do not report when Claude is working until they are reopened.
- The mod API it uses is in early access and may change between Claude Code releases.

This is an independent community project and is not affiliated with or endorsed by Anthropic.

## License

MIT
