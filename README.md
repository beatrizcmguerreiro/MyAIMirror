# My AI Mirror - Reflective Awareness Monitor

My AI Mirror is a research prototype that helps people reflect on how they use AI
chatbots. It highlights interaction patterns without diagnosing the user or
assigning a dependency, ability, or wellbeing score.

## Local language analysis

My AI Mirror currently runs two ONNX models in the browser:

- CardiffNLP Twitter RoBERTa classifies submitted prompts as positive, neutral,
  or negative.
- DeBERTa-v3-xsmall NLI estimates four independent intention signals: learning,
  delegation, user reasoning, and critical engagement. Because these are
  multi-label signals, more than one may be present in the same prompt.

Model files are downloaded from Hugging Face on first use and cached by the
browser. Inference then runs locally through Transformers.js and ONNX Runtime
Web. Prompt text is used only for the inference call and is not saved by
My AI Mirror. Persistent analysis storage contains only each submitted prompt's
sentiment classification and score, plus its intention classifications and
scores. Counts, rates, averages, and summaries are calculated when needed and
are not persisted. Timestamps and message identifiers are not included.

The records are grouped under a hashed conversation identifier so My AI Mirror can
calculate patterns for each chat without storing the ChatGPT conversation URL.
Message de-duplication identifiers are session-only and are not included in
persistent extension storage.

## Behavioural interaction metrics

My AI Mirror measures three process-level signals while a prompt is being written:

- copy-pasting counts paste events, including pasted images, without reading or
  saving clipboard content;
- editing counts deletion, replacement, undo, and redo actions;
- revisions group consecutive editing actions into episodes. For example,
  deleting five characters consecutively counts as five editing actions but
  one revision episode.

Only aggregate numeric totals are persisted. My AI Mirror does not persist raw
keystrokes, draft text, pasted content, hesitation time, or drafting time. The
current prompt's numeric counts are reported in the browser console and are not
yet used in a user-facing visualization.

The console groups these five values into the current prompt, current page
session, and all-time views: paste events, editing actions, revision episodes,
copy-paste rate, and editing rate. Rates apply to the aggregate views because a
single prompt can only contain or not contain each behaviour.

The intention threshold and category wording are provisional research choices.
They must be evaluated against the manually labelled test set before the
visualization is treated as a validated research result.

## Conversation minimap intention layer

The right-side conversation minimap keeps its miniature representation of the
chat and adds a subtle translucent layer behind user prompts classified with an
intention. Learning/explanation is peach, delegation is pale yellow, user
reasoning is pale green, and critical engagement is pale blue. An analysed
prompt with no category above the threshold is unclear and appears in pale red;
prompts that have not been analysed
remain uncoloured. Prompts with multiple detected intentions use a multi-colour
gradient. The layer reads the classifier output directly and does not add
another classification rule. To prevent stored results from becoming
misaligned after ChatGPT rerenders or duplicate analyses, visible historical
prompts are reanalysed locally for the minimap and linked directly to their DOM
message. This temporary mapping remains in memory and prompt text is not added
to persistent storage.

## Post-response reflection

After a completed assistant response, My AI Mirror can show a compact, optional
reflection asking the user to notice how the response affected their thinking:
whether it created understanding, prompted independent reasoning, invited
further questioning, or was accepted as given. The selected category is stored
locally against a hashed conversation identifier; neither the prompt nor the
response text is saved. The card can be disabled from My AI Mirror's visualization
controls and is not shown in temporary chats.

## All-chat usage overview

A small plus button beside ChatGPT's search control opens a local overview of
usage across every chat represented in My AI Mirror's storage. Unlike the raw
summaries on the new-chat screen, this panel combines signals to show active
engagement versus delegation, recurring intention combinations, writing
behaviour grouped by each chat's dominant intention, sentiment-intention
relationships, and agreement between classifier results and comparable user
reflections. The overview does not display or persist conversation text, and it
updates when the underlying local records change.
