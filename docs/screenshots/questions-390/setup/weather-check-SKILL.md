---
name: weather-check
description: Checks the weather with a test API key.
required_environment_variables:
  - name: WEATHER_KEY_390
    prompt: Enter the weather test API key
    help: Any value works on this throwaway server.
---
# Weather check

Reads WEATHER_KEY_390 and reports whether it is set.
