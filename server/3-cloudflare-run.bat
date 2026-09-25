@echo off
echo Starting Cloudflare Quick Tunnel...
echo Wait a few seconds, then look for the URL ending in ".trycloudflare.com"
echo.
"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:4000
pause
