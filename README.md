# Pelham Civic Guide

A single-page guide to local government in Pelham, NY — how the two villages,
the Town, the school district, and Westchester County fit together; where
property taxes go; current issues; and how to get involved. Includes an
"Ask Pelham" chat box backed by Claude.

## Structure

| Path | Purpose |
|---|---|
| `index.html` | The entire site — markup, styles, and scripts in one file. |
| `netlify/functions/ask-pelham.js` | Serverless proxy. The browser POSTs `{ system, messages }` to `/api/ask`; this function adds the model and the secret API key and forwards to the Anthropic API. |
| `netlify.toml` | Static-site config + the `/api/ask` → function rewrite. |

## How the AI chat works

The browser never sees the API key. `askClaude()` in `index.html` calls
`/api/ask`, which `netlify.toml` rewrites to the `ask-pelham` function. The
function reads `ANTHROPIC_API_KEY` from the environment, calls Anthropic, and
returns the response.

Model and token limit are set at the top of `netlify/functions/ask-pelham.js`
(`MODEL`, `MAX_TOKENS`).

## Deploy (Netlify)

1. Connect this GitHub repo to a Netlify site (no build command; publish
   directory `.`).
2. In **Site configuration → Environment variables**, add:
   - `ANTHROPIC_API_KEY` = your Anthropic API key
3. Deploy. Test the "Ask Pelham" box on the live site.

## Local development

```
npm install -g netlify-cli
netlify dev
```

`netlify dev` serves `index.html` and runs the function locally at
`/api/ask`. Provide the key for local runs via a `.env` file (git-ignored):

```
ANTHROPIC_API_KEY=sk-ant-...
```
