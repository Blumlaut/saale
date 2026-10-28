# Firefox AI chatbot sidebar

Firefox's AI chatbot sidebar (Firefox Labs → AI Chatbot) opens whatever URL
`browser.ml.chat.provider` holds, and hands it the prompt as `?q=`. Point it at
Saale and the selected text of a page becomes the first message of a chat, with
the agent answering it in the sidebar.

## Settings

`about:config`:

| Pref                       | Value                                                  |
| -------------------------- | ------------------------------------------------------ |
| `browser.ml.chat.enabled`  | `true`                                                 |
| `browser.ml.chat.sidebar`  | `true` (sidebar; `false` opens it in a tab)            |
| `browser.ml.chat.provider` | `https://saale.example.com` or `http://localhost:3630` |

The sidebar is a browser-owned frame, so Saale's `frame-ancestors` and
`X-Frame-Options` do not apply to it. It signs in with the same cookie a tab
does, and a signed-out visit comes back to the prompt after login.

## The reverse proxy in front of it

The prompt travels in the URL, and Saale answers `/` with a redirect that
carries it to the chat. Two nginx defaults are too small for that: the request
line buffer, and the buffer that holds a response's headers. A prompt of a few
thousand characters gets a 502 (the `Location` header is bigger than the header
buffer) and a longer one a 414.

The snippets below set both to 32k, which covers every prompt the sidebar can
send: Firefox truncates at `browser.ml.chat.maxLength`, 7000 characters, before
it is percent-encoded.

nginx-proxy-manager: Proxy Hosts → the host → Edit → **Advanced**.

```nginx
large_client_header_buffers 4 32k;
proxy_buffer_size 32k;
proxy_buffers 8 32k;
```

A plain nginx server block takes the same three lines inside its `location`.

## Prompts

The context menu and the shortcuts offer `browser.ml.chat.prompts.N`, each a
string pref holding either the prompt text or JSON with a `label`, `value`, `id`
and optional `targeting`. A value can use `%selection%`, `%tabTitle%`, `%url%`
and `%pageUrl%`; Firefox fills them in as `<selection>`, `<tabTitle>`, `<url>`
and `<pageUrl>` tags.

The built-in ones (Summarize, Explain, Proofread, Quiz, Simplify) work as they
come. A custom one is one pref:

```
browser.ml.chat.prompts.7 = {"id":"saale-task","label":"Add to tasks","value":"Create a task for this selection, due Friday: %selection%"}
```

`browser.ml.chat.maxLength` (7000 by default) caps the request; a longer
selection is truncated before it reaches Saale. `browser.ml.chat.prompt.prefix`
is the sentence prepended to every selection prompt, and
`browser.ml.chat.shortcuts` turns the selection shortcuts on or off.

Saale holds the whole conversation, so a follow-up in the sidebar continues the
same chat. Refreshing the sidebar drops back to the chat list, because the
prompt is no longer in the URL.

## What reaches the agent

A selection prompt arrives as, for example:

```
I’m on page “Composer” with “<selection>a & b</selection>” selected.

Please explain the key concepts in this selection, using simple words. Also, use examples.
```

Summarize page sends the URL instead of the text:
`Please summarize the webpage at <pageUrl>https://…</pageUrl> …`. Saale's
`web_fetch` tool reads it.

The prompt is delivered as a chat message, so the agent can call tools while
answering it. Text a page controls (a selection) can steer those tools, so treat
it like any other pasted text.
