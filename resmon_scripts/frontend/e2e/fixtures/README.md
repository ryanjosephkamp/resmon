# PDF fixture

`math-embedded.pdf` is page 2 of [Wireless Link Scheduling with Graph Signal
Diffusion](https://arxiv.org/abs/2611.08274v1), by Teresa Shang, Romina Garcia
Camargo, Yiğit Berkay Uslu, and Alejandro Ribeiro, used under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

The page was extracted with Ghostscript 10.08.0's `pdfwrite`, with
`-dFirstPage=2 -dLastPage=2`. The content and embedded math fonts are retained;
links to omitted pages are discarded. It exercises Type 1 fonts whose math
encodings differ from ordinary text fonts.
