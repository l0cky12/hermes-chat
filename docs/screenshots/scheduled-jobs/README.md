# Scheduled jobs screenshots

Captured on 2026-11-02 from the running Tauri debug application (WebKitGTK) on an Xvfb display, cropped to its 1280 × 820
window. The app was signed in to a real Hermes dashboard (`bf0203a`) serving a throwaway `HERMES_HOME` under `/tmp`, with a
throwaway gateway running its scheduler, and with no provider or platform credentials. Every job is a synthetic `[fixture]`
job made for these captures; none of the owner's jobs is shown. Times are the fixture profile's `America/Chicago`. No
visual elements were composited or retouched. `2-job-detail.png` is from the final build; the others are from the build of
`ec4e93d`, which differs on these screens only by the missed-run sentence in a job's Schedule section and the run
history's Show more.

- `1-job-list.png`: the list, with each job's schedule in words, Hermes's schedule, next run, last result and delivery; a
  paused job.
- `2-job-detail.png`: a 2:30 AM job: time zone, Hermes's next run, upcoming runs, what happens on the spring-forward day,
  and what Hermes does with a missed run.
- `3-editor-validation.png`: an invalid cron hour caught before anything is sent.
- `4-editor-preview.png`: a new schedule explained and previewed (weekends skipped).
- `5-edit-conflict.png`: the job renamed on the server by another client while the editor was open; nothing was sent.
- `6-run-now-confirm.png`: Run now asks first and says what the run does (a script fixture that prints one line).
- `7-run-now-result.png`: the run finished, confirmed by reading the job back.
- `8-run-history.png`: Hermes's run history for that job. The 2:37 and 2:39 PM runs were made by the scheduler with no
  Hermes Chat process running; 3:03 PM is the Run now above.
- `9-copy-warning.png`: a job whose id is also in another profile (copied into the throwaway `fixture-b` profile's store).
- `10-delete-confirm.png`: Delete asks first.
- `11-disconnected.png`: the dashboard stopped: actions are off, and the last list read stays, marked as such.
