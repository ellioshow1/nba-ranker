# NBA Ranker

Rank every active NBA player head to head, then see how your list compares with a stats robot.
Live at https://ellioshow1.github.io/nba-ranker/

## How it works

1. **Pick who's in.** Presets (Stars, Starters, Rotation players, Everyone) or your own filters: season to judge on,
   minutes, games, minutes per game, starters/bench, position, conference, teams, rookies, injured players,
   a cap on the robot's top N, and any individual player added or removed by hand.
2. **Matchups.** Two players at a time: who's better right now? Every pick updates Elo ratings, so every player
   always has an exact place. Pairing favours players with the fewest matchups, against someone close in rating
   they haven't met yet. Rough ≈ 4 matchups each, Solid ≈ 8, Sharp ≈ 14.
3. **Vs robot.** The robot ranks the same pool from stats alone. You get rank agreement (Spearman), the biggest
   disagreements both ways, a your-rank-vs-robot-rank scatter and the two top 25s side by side.
4. **Share.** A link that carries your whole ranking (opens a read-only view that compares it with the robot, and
   with the viewer's own ranking if they have one), an image of your top 10/25/50, or plain text.

Everything is stored in your browser. Nothing is sent anywhere.

## The robot

Blends three box-score parts, each standardised across players with 300+ minutes:

- 55%: production per 36 minutes (John Hollinger's Game Score)
- 30%: production per game (rewards big roles)
- 15%: team plus-minus with him on court, heavily smoothed

Last season and this season are pooled, this season's games counting double, so early in a season it leans on last
season. Per-36 rates are regressed toward a fringe-rotation level with 600 minutes, so small samples can't spike.
Tuning lives in `ROBOT` in `js/stats.js`.

## Data

`scripts/build_data.py` pulls every rostered player (with injuries) and their regular-season stats for last season
and this season from ESPN's public JSON endpoints, into `data/players.json`. The GitHub Action
(`.github/workflows/deploy.yml`) rebuilds it on every push and daily at 09:00 UTC, then deploys. If ESPN is
unreachable it deploys the committed copy, so refresh that now and then:

```
python scripts/build_data.py
```

## Run it locally

Double-click `start.bat`, or run `python -m http.server 8771 --bind 127.0.0.1` here and open http://127.0.0.1:8771/

## Files

- `js/elo.js`: Elo ratings (replayed from your picks), pairing, progress levels
- `js/stats.js`: season lines, the robot, filters and presets
- `js/share.js`: share links (ids packed 3 bytes each, base64url) and the share image
- `js/app.js`: UI
- `scripts/build_data.py`: data build
