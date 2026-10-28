@echo off
rem Serves NBA Ranker at http://127.0.0.1:8771/
cd /d "%~dp0"
start "" http://127.0.0.1:8771/
python -m http.server 8771 --bind 127.0.0.1
