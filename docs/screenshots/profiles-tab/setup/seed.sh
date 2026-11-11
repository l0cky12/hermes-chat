#!/bin/sh
# Synthetic profiles on the throwaway dashboard (dash.sh), made through Hermes's own routes.
B=http://127.0.0.2:21550; J=/tmp/hermes-447/cookies
curl -s -c $J -H 'content-type: application/json' -d '{"provider":"basic","username":"verify","password":"verify-pass"}' $B/auth/password-login
for body in '{"name":"coder","description":"Writes and reviews code in the hermes-chat repo"}' '{"name":"research","description":"Reads papers and summarises them"}' '{"name":"scratch"}'; do
  curl -s -b $J -H 'content-type: application/json' -d "$body" $B/api/profiles
done
# A synthetic key so Hermes's model list offers OpenRouter's models; never a real one.
printf 'OPENROUTER_API_KEY=sk-or-v1-synthetic-447-not-a-real-key\n' >> /tmp/hermes-447/home/.hermes/.env
curl -s -b $J -X PUT -H 'content-type: application/json' -d '{"provider":"openrouter","model":"anthropic/claude-sonnet-4.5"}' $B/api/profiles/coder/model
