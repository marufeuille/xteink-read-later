export const EPUB_CSS = `body {
  line-height: 1.7;
  margin: 1em;
}
h1, h2, h3, h4, h5, h6 {
  font-weight: bold;
  line-height: 1.3;
}
p, li {
  margin: 0.6em 0;
}
pre, code {
  font-family: monospace;
  white-space: pre-wrap;
  word-wrap: break-word;
}
a {
  text-decoration: underline;
}
.source {
  font-size: 0.9em;
}
`

export const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`
