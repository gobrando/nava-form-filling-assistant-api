# Form-fill cost view for the AI PM dashboard

This patch belongs on [genai-product-dashboard](https://github.com/gobrando/genai-product-dashboard) at `4130c30`. It could not be pushed there: GitHub denied `cursor[bot]` write access. The commits on the machine that produced it are `1425cc7` and `d3c49d2` (tip `d3c49d2`).

Apply it from a checkout of that revision:

```bash
git checkout 4130c30
git apply patches/form-fill-cost-board.patch
python -m unittest discover -s tests -v
DASHBOARD_CONFIG=products/nava-form-filling.yaml streamlit run dashboard.py
```

The view does not connect to Phoenix. Every number is a scenario. A warm run costs nothing. A refusal is costed as one cold run. Defaults are 0.05 USD per model turn, 10 turns, and a 5-of-9 close share from the local drift lab fixture set, not a county volume. Readback is not a model turn. The product does not submit.
