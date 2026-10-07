@echo off
REM Kindle Deck - start serwera. Pierwsze uruchomienie tworzy venv i instaluje paczki.
cd /d "%~dp0"
if not exist .venv (
    echo Tworze srodowisko .venv ...
    python -m venv .venv || goto :err
    .venv\Scripts\python -m pip install --upgrade pip
    .venv\Scripts\python -m pip install -r requirements.txt || goto :err
)
.venv\Scripts\python server.py
pause
goto :eof
:err
echo Blad instalacji - czy Python 3.10+ jest w PATH?
pause
