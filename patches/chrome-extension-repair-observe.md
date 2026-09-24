# Chrome extension repair observer

This patch belongs on [nava-form-filling-assistant-chrome-extension](https://github.com/gobrando/nava-form-filling-assistant-chrome-extension) at `b46c058` (merge of `feat/client-link`). It could not be pushed there: GitHub denied `cursor[bot]` write access to that repository. The commit on the machine that produced it is `6df19db`.

Apply it from a checkout of that revision:

```bash
git checkout b46c058
git apply patches/chrome-extension-repair-observe.patch
```

The patch adds a dry run of `POST /v1/programs/{slug}/playbook/repair` from the open page. The observation is selectors, labels, types, and counts. It never sends a value. Publishing is a second confirmed step, and only when the API says the repair is publishable.
