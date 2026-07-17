# API quick start

## Builder contract

Create a plain ES module that exports one async function and returns a PptxGenJS presentation:

```js
export default async function build({ createDeck, layouts, resolveDesignTokens, pptxgenjs, imageSizingCrop }) {
  const tokens = await resolveDesignTokens({
    lang: 'zh-CN',
    profile: 'cross-platform-zh',
    density: 'presentation',
  });
  const pptx = await createDeck({ title: 'Example deck', lang: 'zh-CN', tokens });

  layouts.titleSlide(pptx, tokens, {
    eyebrow: 'Example',
    title: 'A clear title',
    subtitle: 'One sentence of useful context.',
    meta: 'Team · 2026',
  });

  layouts.chartSlide(pptx, tokens, {
    title: 'Adoption increased in every segment',
    type: pptx.ChartType.bar,
    series: [{ name: 'Adoption', labels: ['A', 'B', 'C'], values: [42, 57, 71] }],
    takeaway: 'Segment C leads by 14 points.',
    source: 'Source: verified internal data',
    page: 2,
  });

  return pptx;
}
```

Use `build` while iterating. Use `deliver` for the final build so the verified hash, audit, and render remain bound to one PPTX:

```bash
bash "$PPTX" build --builder deck.mjs --out deck.pptx
bash "$PPTX" deliver --builder deck.mjs --out deck.pptx --qa-dir qa --target-platform cross-platform --require-render
```

## Toolkit members

- `createDeck(options)`: create a themed wide-screen presentation.
- `resolveDesignTokens(options)`: select locale, platform, and density-aware typography tokens.
- `layouts`: the 12 PilotDeck core layout functions.
- `tokens`: canvas, palette, typography, and spacing values.
- `pptxgenjs`: the PptxGenJS constructor and enum holder; access `pptx.ShapeType` and `pptx.ChartType` from the created instance when possible.
- `imageSizingCrop(path, x, y, w, h)`: prepare a centered crop.
- `imageSizingContain(path, x, y, w, h)`: fit an image without distortion.

## Object naming

Set PptxGenJS `objectName` for meaningful elements. Use stable names such as `Slide Title`, `Primary Chart`, `Hero Image`, and `Page Number`. Template frame maps address objects by the names exposed in `inspect` output.

## Useful commands

```bash
bash "$PPTX" convert --input legacy.ppt --out converted.pptx --qa-dir legacy-qa
bash "$PPTX" scaffold --out deck.mjs
bash "$PPTX" build --builder deck.mjs --out deck.pptx --verify --qa-dir qa
bash "$PPTX" deliver --builder deck.mjs --out deck.pptx --qa-dir qa --require-render
bash "$PPTX" deliver --input qa/candidate.pptx --out deck.pptx --qa-dir qa --requirements requirements.json --require-coverage --dispositions warning-dispositions.json --require-render
bash "$PPTX" inspect --input deck.pptx --out manifest.json
bash "$PPTX" audit --input deck.pptx --out audit.json --target-platform cross-platform
bash "$PPTX" render --input deck.pptx --out-dir slides --montage montage.png
```

`deliver --builder` writes an intermediate candidate under the QA directory. The requested output is created only when delivery status is `passed`. Do not bypass the exit status or deliver `candidate.pptx`.
