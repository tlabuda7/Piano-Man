# Piano Man

A phone-friendly web app for learning songs on piano.

- **Learn mode**: the next key lights up and the app waits. Right note: it moves on. Wrong note: it tells you what you played and asks you to try again.
- **Three ways to play**: the phone's microphone (acoustic piano or a keyboard's speakers), a MIDI keyboard (browsers with Web MIDI, so not iPhone Safari), or tapping the on-screen keys.
- **Listen mode**: plays the song at 50/75/100% speed while the keys light up.
- **Practice tools**: loop any section, practice one hand at a time, see your first-try score and jump straight to your hardest bar.
- **Add songs**: import a MIDI file or ABC notation (file or paste).

## Put it on your phone

The app is plain static files, with no build step. The microphone only works over https, so host it:

1. On GitHub: **Settings → Pages → Deploy from a branch**, pick this branch and `/ (root)`.
2. Open the Pages address in Safari on your iPhone.
3. Tap **Share → Add to Home Screen**.

## Adding songs to the built-in list

Built-in songs live in `songs.js` as ABC notation. Imported songs are saved only in the browser they were added in.

"Here's a Health to the Company" uses Henrik Norbeck's transcription of the traditional tune (norbeck.nu).
