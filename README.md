# Vande Mart Central Audio Announcement System

## Run locally

1. Install Node.js 20+.
2. Open this folder in a terminal.
3. Run:
   npm install
   npm start
4. Open:
   http://localhost:3000

## Admin
The home page is the Admin Dashboard.

## Branch Player
Open:
http://YOUR-SERVER/player.html?branch=BRANCHCODE

Example:
http://YOUR-SERVER/player.html?branch=KURNOOL01

## First test
1. Add a branch.
2. Open its player URL.
3. Tap "Enable Speaker".
4. Upload an MP3 and select the branch.
5. Activate it.
6. Set a short interval for testing if desired.

Note:
Browser autoplay restrictions mean each branch device needs a one-time user interaction to enable audio. This starter version uses the server schedule so branches use the same schedule rather than independent local timers.
