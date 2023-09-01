// tslint:disable no-var-requires member-ordering

import * as cheerio from 'cheerio';
import { execFile } from 'child_process';
import CryptoJS from 'crypto-js';
import * as fs from 'fs';
import { escape } from 'html-escaper';
import * as path from 'path';
import puppeteer, { Browser } from 'puppeteer-core';
import request from 'request';
import { JsonObject } from 'type-fest';
import * as vscode from 'vscode';
import * as YAML from 'yaml';
import { CodeChunkData } from '../code-chunk/code-chunk-data';
import { ebookConvert } from '../converters/ebook-convert';
import { markdownConvert } from '../converters/markdown-convert';
import { pandocConvert } from '../converters/pandoc-convert';
import { princeConvert } from '../converters/prince-convert';
import { parseBlockAttributes } from '../lib/block-attributes/parseBlockAttributes';
import { stringifyBlockAttributes } from '../lib/block-attributes/stringifyBlockAttributes';
import { normalizeBlockInfo } from '../lib/block-info/normalizeBlockInfo';
import { parseBlockInfo } from '../lib/block-info/parseBlockInfo';
import { FileSystemApi, Notebook, getDefaultNotebookConfig } from '../notebook';
import enhanceWithCodeBlockStyling from '../render-enhancers/code-block-styling';
import enhanceWithEmbeddedLocalImages from '../render-enhancers/embedded-local-images';
import enhanceWithEmbeddedSvgs from '../render-enhancers/embedded-svgs';
import enhanceWithExtendedTableSyntax from '../render-enhancers/extended-table-syntax';
import enhanceWithFencedCodeChunks, {
  RunCodeChunkOptions,
  runCodeChunk,
  runCodeChunks,
} from '../render-enhancers/fenced-code-chunks';
import enhanceWithFencedDiagrams from '../render-enhancers/fenced-diagrams';
import enhanceWithFencedMath from '../render-enhancers/fenced-math';
import enhanceWithResolvedImagePaths from '../render-enhancers/resolved-image-paths';
import * as utility from '../utility';
import { removeFileProtocol } from '../utility';
import HeadingIdGenerator from './heading-id-generator';
import { HeadingData, generateSidebarToCHTML } from './toc';
import { transformMarkdown } from './transformer';

interface MarkdownEngineConstructorArgs {
  /**
   * The notebook
   */
  notebook: Notebook;
  /**
   * The note file path. It needs to be absolute path.
   */
  filePath: string;
}

export interface MarkdownEngineRenderOption {
  useRelativeFilePath: boolean;
  isForPreview: boolean;
  hideFrontMatter: boolean;
  triggeredBySave?: boolean;
  runAllCodeChunks?: boolean;
  emojiToSvg?: boolean;
  vscodePreviewPanel?: vscode.WebviewPanel | null;
  fileDirectoryPath?: string;
}

export interface MarkdownEngineOutput {
  html: string;
  markdown: string;
  tocHTML: string;
  yamlConfig: JsonObject;
  /**
   * imported javascript and css files
   * convert .js file to <script src='...'></script>
   * convert .css file to <link href='...'></link>
   */
  JSAndCssFiles: string[];
  // slideConfigs: Array<object>
}

export interface HTMLTemplateOption {
  /**
   * whether is for print.
   */
  isForPrint: boolean;
  /**
   * whether is for prince export.
   */
  isForPrince: boolean;
  /**
   * whether for offline use
   */
  offline: boolean;
  /**
   * whether to embed local images as base64
   */
  embedLocalImages: boolean;
  /**
   * whether to embed svg images
   */
  embedSVG?: boolean;
}

let MODIFY_SOURCE:
  | ((
      codeChunkData: CodeChunkData,
      result: string,
      filePath: string,
    ) => Promise<string>)
  | null = null;

const dependentLibraryMaterials = [
  {
    key: 'vega-embed',
    version: '6.22.2',
  },
];

/**
 * The markdown engine that can be used to parse markdown and export files
 */
export class MarkdownEngine {
  /**
   * Modify markdown source, append `result` after corresponding code chunk.
   * @param codeChunkData
   * @param result
   */
  public static async modifySource(
    codeChunkData: CodeChunkData,
    result: string,
    filePath: string,
  ) {
    if (MODIFY_SOURCE) {
      await MODIFY_SOURCE(codeChunkData, result, filePath);
    } else {
      // TODO: directly modify the local file.
    }

    codeChunkData.running = false;
    return result;
  }

  /**
   * Bind cb to MODIFY_SOURCE
   * @param cb
   */
  public static onModifySource(
    cb: (
      codeChunkData: CodeChunkData,
      result: string,
      filePath: string,
    ) => Promise<string>,
  ) {
    MODIFY_SOURCE = cb;
  }

  /**
   * markdown file path
   */
  private readonly filePath: string;
  private readonly fileDirectoryPath: string;
  private readonly projectDirectoryPath: string;
  private readonly notebook: Notebook;
  private readonly fs: FileSystemApi;

  private headings: HeadingData[];
  private tocHTML: string;

  /**
   * Dirty variable just made for VSCode preview.
   */
  private vscodePreviewPanel: vscode.WebviewPanel | null | undefined;

  // caches
  private graphsCache: { [key: string]: string } = {};

  // code chunks
  private codeChunksData: { [key: string]: CodeChunkData } = {};

  // files cache
  private filesCache: { [key: string]: string } = {};

  /**
   * cachedHTML is the cache of html generated from the markdown file.
   */
  // private cachedHTML:string = '';

  /**
   * Check whether the preview is in presentation mode.
   */
  public isPreviewInPresentationMode: boolean = false;

  constructor({ filePath, notebook }: MarkdownEngineConstructorArgs) {
    this.filePath = filePath;
    this.notebook = notebook;
    this.fileDirectoryPath = path.dirname(this.filePath);
    this.projectDirectoryPath =
      this.notebook.notebookPath || this.fileDirectoryPath;
    this.fs = this.notebook.fs;

    this.headings = [];
    this.tocHTML = '';
  }

  get protocolsWhiteListRegExp() {
    // protocal whitelist
    const protocolsWhiteList = (
      this.notebook.config.protocolsWhiteList ??
      getDefaultNotebookConfig().protocolsWhiteList ??
      ''
    )
      .split(',')
      .map(x => x.trim());
    return new RegExp('^(' + protocolsWhiteList.join('|') + ')'); // eg /^(http:\/\/|https:\/\/|atom:\/\/|file:\/\/|mailto:|tel:)/
  }

  public cacheCodeChunkResult(id: string, result: string) {
    const codeChunkData = this.codeChunksData[id];
    if (!codeChunkData) {
      return;
    }
    codeChunkData.result = CryptoJS.AES.decrypt(result, 'crossnote').toString(
      CryptoJS.enc.Utf8,
    );
  }

  /**
   * Generate scripts string for preview usage.
   */
  private generateScriptsForPreview(
    isForPresentation = false,
    yamlConfig = {},
    vscodePreviewPanel: vscode.WebviewPanel | null = null,
  ) {
    let scripts = '';

    // prevent `id="exports"` element from linked to `window` object.
    scripts += `<script>var exports = undefined</script>`;

    // jquery
    scripts += `<script type="text/javascript" src="${utility.addFileProtocol(
      path.resolve(
        utility.getExtensionDirectoryPath(),
        './dependencies/jquery/jquery.js',
      ),
      vscodePreviewPanel,
    )}" charset="UTF-8"></script>`;

    // jquery contextmenu
    scripts += `<script type="text/javascript" src="${utility.addFileProtocol(
      path.resolve(
        utility.getExtensionDirectoryPath(),
        './dependencies/jquery-contextmenu/jquery.ui.position.min.js',
      ),
      vscodePreviewPanel,
    )}" charset="UTF-8"></script>`;
    scripts += `<script type="text/javascript" src="${utility.addFileProtocol(
      path.resolve(
        utility.getExtensionDirectoryPath(),
        './dependencies/jquery-contextmenu/jquery.contextMenu.min.js',
      ),
      vscodePreviewPanel,
    )}" charset="UTF-8"></script>`;

    // jquery modal
    scripts += `<script type="text/javascript" src="${utility.addFileProtocol(
      path.resolve(
        utility.getExtensionDirectoryPath(),
        './dependencies/jquery-modal/jquery.modal.min.js',
      ),
      vscodePreviewPanel,
    )}" charset="UTF-8"></script>`;

    // mermaid
    scripts += `<script type="text/javascript" src="${utility.addFileProtocol(
      path.resolve(
        utility.getExtensionDirectoryPath(),
        `./dependencies/mermaid/mermaid.min.js`,
      ),
      vscodePreviewPanel,
    )}" charset="UTF-8"></script>`;
    // TODO: If ZenUML gets integrated into mermaid in the future,
    //      we can remove the following lines.
    scripts += `<script type="module">
    import zenuml from 'https://cdn.jsdelivr.net/npm/@mermaid-js/mermaid-zenuml@0.1.0/dist/mermaid-zenuml.esm.min.mjs';
    await mermaid.registerExternalDiagrams([zenuml]);
  </script>`;

    // wavedrome
    scripts += `<script type="text/javascript" src="${utility.addFileProtocol(
      path.resolve(
        utility.getExtensionDirectoryPath(),
        './dependencies/wavedrom/default.js',
      ),
      vscodePreviewPanel,
    )}" charset="UTF-8"></script>`;
    scripts += `<script type="text/javascript" src="${utility.addFileProtocol(
      path.resolve(
        utility.getExtensionDirectoryPath(),
        './dependencies/wavedrom/wavedrom.min.js',
      ),
      vscodePreviewPanel,
    )}" charset="UTF-8"></script>`;

    // math
    if (
      this.notebook.config.mathRenderingOption === 'MathJax' ||
      this.notebook.config.usePandocParser
    ) {
      const mathJaxConfig = this.notebook.config.mathjaxConfig;
      mathJaxConfig['tex'] = mathJaxConfig['tex'] || {};
      mathJaxConfig['tex'][
        'inlineMath'
      ] = this.notebook.config.mathInlineDelimiters;
      mathJaxConfig['tex'][
        'displayMath'
      ] = this.notebook.config.mathBlockDelimiters;

      // https://docs.mathjax.org/en/latest/options/startup/startup.html#the-configuration-block
      // Disable typesetting on startup
      mathJaxConfig['startup'] = mathJaxConfig['startup'] || {};
      mathJaxConfig['startup']['typeset'] = false;
      mathJaxConfig['startup']['elements'] = ['.hidden-preview']; // Only render on this element

      scripts += `<script type="text/javascript"> window.MathJax = (${JSON.stringify(
        mathJaxConfig,
      )}); </script>`;
      scripts += `<script type="text/javascript" async src="${this.notebook.config.mathjaxV3ScriptSrc}" charset="UTF-8"></script>`;
    }

    // reveal.js
    if (isForPresentation) {
      scripts += `<script src='${utility.addFileProtocol(
        path.resolve(
          utility.getExtensionDirectoryPath(),
          './dependencies/reveal/lib/js/head.min.js',
        ),
        vscodePreviewPanel,
      )}'></script>`;
      scripts += `<script src='${utility.addFileProtocol(
        path.resolve(
          utility.getExtensionDirectoryPath(),
          './dependencies/reveal/js/reveal.js',
        ),
        vscodePreviewPanel,
      )}'></script>`;

      let presentationConfig = yamlConfig['presentation'] || {};
      if (typeof presentationConfig !== 'object') {
        presentationConfig = {};
      }
      let dependencies = presentationConfig['dependencies'] || [];
      if (!(dependencies instanceof Array)) {
        dependencies = [];
      }
      presentationConfig['dependencies'] = dependencies;

      scripts += `
      <script>
        Reveal.initialize(${JSON.stringify({
          margin: 0.1,
          ...presentationConfig,
        })})
      </script>
      `;
    }

    // mermaid init
    scripts += `<script>
var MERMAID_CONFIG = (${JSON.stringify(this.notebook.config.mermaidConfig)});
if (typeof MERMAID_CONFIG !== 'undefined') {
  MERMAID_CONFIG.startOnLoad = false
  MERMAID_CONFIG.cloneCssStyles = false
  MERMAID_CONFIG.theme = "${this.notebook.config.mermaidTheme}"
}
mermaid.initialize(MERMAID_CONFIG || {})
if (typeof(window['Reveal']) !== 'undefined') {
  function mermaidRevealHelper(event) {
    var currentSlide = event.currentSlide
    var diagrams = currentSlide.querySelectorAll('.mermaid')
    for (var i = 0; i < diagrams.length; i++) {
      var diagram = diagrams[i]
      if (!diagram.hasAttribute('data-processed')) {
        mermaid.init(null, diagram, ()=> {
          Reveal.slide(event.indexh, event.indexv)
        })
      }
    }
  }
  Reveal.addEventListener('slidechanged', mermaidRevealHelper)
  Reveal.addEventListener('ready', mermaidRevealHelper)
} else {
  // The line below will cause mermaid bug in preview.
  // mermaid.init(null, document.querySelectorAll('.mermaid'))
}
</script>`;

    // wavedrom init script
    if (isForPresentation) {
      scripts += `<script>
  WaveDrom.ProcessAll()
      </script>`;
    }

    // vega
    dependentLibraryMaterials.forEach(({ key }) => {
      scripts += `<script src="${utility.addFileProtocol(
        path.resolve(
          utility.getExtensionDirectoryPath(),
          `./dependencies/${key}/${key}.min.js`,
        ),
        vscodePreviewPanel,
      )}" charset="UTF-8"></script>`;
    });

    if (isForPresentation) {
      scripts += `<script>
      var vegaEls = document.querySelectorAll('.vega, .vega-lite');
      function reportVegaError(el, error) {
        el.innerHTML = '<pre class="language-text">' + error.toString() + '</pre>'
      }
      for (var i = 0; i < vegaEls.length; i++) {
        const vegaEl = vegaEls[i]
        try {
          var spec = JSON.parse(vegaEl.textContent);
          vegaEmbed(vegaEl, spec, { actions: false, renderer: 'svg' })
          .catch(function(error) {
            reportVegaError(vegaEl, error);
          })
        } catch (error) {
          reportVegaError(vegaEl, error);
        }
      }
      </script>`;
    }

    return scripts;
  }

  /**
   * Map preview theme to prism theme.
   */
  private static AutoPrismThemeMap = {
    'atom-dark.css': 'atom-dark.css',
    'atom-light.css': 'atom-light.css',
    'atom-material.css': 'atom-material.css',
    'github-dark.css': 'atom-dark.css',
    'github-light.css': 'github.css',
    'gothic.css': 'github.css',
    'medium.css': 'github.css',
    'monokai.css': 'monokai.css',
    'newsprint.css': 'pen-paper-coffee.css', // <= this is bad
    'night.css': 'darcula.css', // <= this is bad
    'one-dark.css': 'one-dark.css',
    'one-light.css': 'one-light.css',
    'solarized-light.css': 'solarized-light.css',
    'solarized-dark.css': 'solarized-dark.css',
    'vue.css': 'vue.css',
  };

  private static AutoPrismThemeMapForPresentation = {
    'beige.css': 'pen-paper-coffee.css',
    'black.css': 'one-dark.css',
    'blood.css': 'monokai.css',
    'league.css': 'okaidia.css',
    'moon.css': 'funky.css',
    'night.css': 'atom-dark.css',
    'serif.css': 'github.css',
    'simple.css': 'github.css',
    'sky.css': 'default.css',
    'solarized.css': 'solarized-light.css',
    'white.css': 'default.css',
  };

  /**
   * Automatically pick code block theme for preview.
   */
  private getPrismTheme(isPresentationMode = false, yamlConfig = {}) {
    if (this.notebook.config.codeBlockTheme === 'auto.css') {
      /**
       * Automatically pick code block theme for preview.
       */
      if (isPresentationMode) {
        const presentationTheme =
          yamlConfig['presentation'] &&
          typeof yamlConfig['presentation'] === 'object' &&
          yamlConfig['presentation']['theme']
            ? yamlConfig['presentation']['theme']
            : this.notebook.config.revealjsTheme;
        return (
          MarkdownEngine.AutoPrismThemeMapForPresentation[presentationTheme] ||
          'default.css'
        );
      } else {
        return (
          MarkdownEngine.AutoPrismThemeMap[this.notebook.config.previewTheme] ||
          'default.css'
        );
      }
    } else {
      return this.notebook.config.codeBlockTheme;
    }
  }

  /**
   * Generate styles string for preview usage.
   */
  private generateStylesForPreview(
    isPresentationMode = false,
    yamlConfig = {},
    vscodePreviewPanel: vscode.WebviewPanel | null = null,
  ) {
    let styles = '';

    // loading.css
    styles += `<link rel="stylesheet" href="${utility.addFileProtocol(
      path.resolve(utility.getExtensionDirectoryPath(), './styles/loading.css'),
      vscodePreviewPanel,
    )}">`;

    // jquery-contextmenu
    styles += `<link rel="stylesheet" href="${utility.addFileProtocol(
      path.resolve(
        utility.getExtensionDirectoryPath(),
        `./dependencies/jquery-contextmenu/jquery.contextMenu.min.css`,
      ),
      vscodePreviewPanel,
    )}">`;

    // jquery-modal
    styles += `<link rel="stylesheet" href="${utility.addFileProtocol(
      path.resolve(
        utility.getExtensionDirectoryPath(),
        `./dependencies/jquery-modal/jquery.modal.min.css`,
      ),
      vscodePreviewPanel,
    )}">`;

    // check math
    if (
      this.notebook.config.mathRenderingOption === 'KaTeX' &&
      !this.notebook.config.usePandocParser
    ) {
      styles += `<link rel="stylesheet" href="${utility.addFileProtocol(
        path.resolve(
          utility.getExtensionDirectoryPath(),
          './dependencies/katex/katex.min.css',
        ),
        vscodePreviewPanel,
      )}">`;
    }

    // check font-awesome
    styles += `<link rel="stylesheet" href="${utility.addFileProtocol(
      path.resolve(
        utility.getExtensionDirectoryPath(),
        `./dependencies/font-awesome/css/font-awesome.min.css`,
      ),
      vscodePreviewPanel,
    )}">`;

    // check preview theme and revealjs theme
    if (!isPresentationMode) {
      styles += `<link rel="stylesheet" href="${utility.addFileProtocol(
        path.resolve(
          utility.getExtensionDirectoryPath(),
          `./styles/preview_theme/${this.notebook.config.previewTheme}`,
        ),
        vscodePreviewPanel,
      )}">`;
    } else {
      styles += `<link rel="stylesheet" href="${utility.addFileProtocol(
        path.resolve(
          utility.getExtensionDirectoryPath(),
          './dependencies/reveal/css/reveal.css',
        ),
        vscodePreviewPanel,
      )}" >`;
      styles += `<link rel="stylesheet" href="${utility.addFileProtocol(
        path.resolve(
          utility.getExtensionDirectoryPath(),
          `./dependencies/reveal/css/theme/${
            yamlConfig['presentation'] &&
            typeof yamlConfig['presentation'] === 'object' &&
            yamlConfig['presentation']['theme']
              ? yamlConfig['presentation']['theme']
              : this.notebook.config.revealjsTheme
          }`,
        ),
        vscodePreviewPanel,
      )}" >`;
    }

    // check prism
    styles += `<link rel="stylesheet" href="${utility.addFileProtocol(
      path.resolve(
        utility.getExtensionDirectoryPath(),
        `./styles/prism_theme/${this.getPrismTheme(
          isPresentationMode,
          yamlConfig,
        )}`,
      ),
      vscodePreviewPanel,
    )}">`;

    // style template
    styles += `<link rel="stylesheet" media="screen" href="${utility.addFileProtocol(
      path.resolve(
        utility.getExtensionDirectoryPath(),
        './styles/style-template.css',
      ),
      vscodePreviewPanel,
    )}">`;

    // style markdown-it-admonition
    styles += `<link rel="stylesheet" media="screen" href="${utility.addFileProtocol(
      path.resolve(
        utility.getExtensionDirectoryPath(),
        './styles/markdown-it-admonition.css',
      ),
      vscodePreviewPanel,
    )}">`;

    // global styles
    styles += `<style>${this.notebook.config.globalCss}</style>`;

    return styles;
  }

  /**
   * Generate <style> and <link> string from an array of file paths.
   * @param JSAndCssFiles
   */
  private generateJSAndCssFilesForPreview(
    JSAndCssFiles: string[] = [],
    vscodePreviewPanel: vscode.WebviewPanel | null = null,
  ) {
    let output = '';
    JSAndCssFiles.forEach(sourcePath => {
      let absoluteFilePath = sourcePath;
      if (sourcePath[0] === '/') {
        absoluteFilePath = utility.addFileProtocol(
          path.resolve(this.projectDirectoryPath, '.' + sourcePath),
          vscodePreviewPanel,
        );
      } else if (
        sourcePath.match(/^file:\/\//) ||
        sourcePath.match(/^https?:\/\//)
      ) {
        // do nothing
      } else {
        absoluteFilePath = utility.addFileProtocol(
          path.resolve(this.fileDirectoryPath, sourcePath),
          vscodePreviewPanel,
        );
      }

      if (absoluteFilePath.endsWith('.js')) {
        output += `<script type="text/javascript" src="${absoluteFilePath}"></script>`;
      } else {
        // css
        output += `<link rel="stylesheet" href="${absoluteFilePath}">`;
      }
    });
    return output;
  }

  /**
   * Generate html template for preview.
   */
  public async generateHTMLTemplateForPreview({
    inputString = '',
    body = '',
    webviewScript = '',
    scripts = '',
    styles = '',
    head = `<base href="${this.filePath}">`,
    config = {},
    vscodePreviewPanel = null,
    contentSecurityPolicy = '',
  }: {
    inputString?: string;
    body?: string;
    webviewScript?: string;
    scripts?: string;
    styles?: string;
    head?: string;
    config: JsonObject;
    vscodePreviewPanel: vscode.WebviewPanel | null | undefined;
    contentSecurityPolicy?: string;
  }): Promise<string> {
    if (!inputString) {
      inputString = await this.fs.readFile(this.filePath);
    }
    if (!webviewScript) {
      webviewScript = utility.addFileProtocol(
        path.resolve(utility.getExtensionDirectoryPath(), './webview/index.js'),
        vscodePreviewPanel,
      );
    }
    if (!body) {
      // default body
      body = `
        <div class="refreshing-icon"></div>
        <div id="md-toolbar">
          <div class="back-to-top-btn btn"><span>⬆︎</span></div>
          <div class="refresh-btn btn"><span>⟳︎</span></div>
          <div class="sidebar-toc-btn btn"><span>§</span></div>
        </div>
        <div id="image-helper-view">
          <h4>Image Helper</h4>
          <div class="upload-div">
            <label>Link</label>
            <input type="text" class="url-editor" placeholder="enter image URL here, then press 'Enter' to insert.">
            <div class="splitter"></div>
            <label class="copy-label">Copy image to root /assets folder</label>
            <div class="drop-area paster">
              <p class="paster"> Click me to browse image file </p>
              <input class="file-uploader paster" type="file" style="display:none;" multiple="multiple" >
            </div>
            <div class="splitter"></div>
            <label>Upload</label>
            <div class="drop-area uploader">
              <p class="uploader">Click me to browse image file</p>
              <input class="file-uploader uploader" type="file" style="display:none;" multiple="multiple" >
            </div>
            <div class="uploader-choice">
              <span>use</span>
              <select class="uploader-select">
                <option>imgur</option>
                <option>sm.ms</option>
                <option>qiniu</option>
              </select>
              <span> to upload images</span>
            </div>
            <a href="#" id="show-uploaded-image-history">Show history</a>
          </div>
        </div>
        <!-- <div class="markdown-spinner"> Loading Markdown\u2026 </div> -->
    `;
    }

    const { yamlConfig, JSAndCssFiles, html } = await this.parseMD(
      inputString,
      {
        isForPreview: true,
        useRelativeFilePath: false,
        hideFrontMatter: false,
        vscodePreviewPanel,
      },
    );
    const isPresentationMode = yamlConfig['isPresentationMode'] as boolean;

    const htmlTemplate = `<!DOCTYPE html>
      <html>
      <head>
        <meta http-equiv="Content-type" content="text/html;charset=UTF-8">
        <meta id="crossnote-data" data-config="${escape(
          JSON.stringify({ ...this.notebook.config, ...config }),
        )}" data-time="${Date.now()}">
        <meta charset="UTF-8">
        ${
          contentSecurityPolicy
            ? `<meta
          http-equiv="Content-Security-Policy"
          content="${contentSecurityPolicy}"
        />`
            : ''
        }
        ${this.generateStylesForPreview(
          isPresentationMode,
          yamlConfig,
          vscodePreviewPanel,
        )}
        ${styles}
        <link rel="stylesheet" href="${utility.addFileProtocol(
          path.resolve(
            utility.getExtensionDirectoryPath(),
            './styles/preview.css',
          ),
          vscodePreviewPanel,
        )}">
        ${this.generateJSAndCssFilesForPreview(
          JSAndCssFiles,
          vscodePreviewPanel,
        )}
        ${head}
      </head>
      <body class="preview-container">
        <div class="crossnote markdown-preview" for="preview" ${
          isPresentationMode ? 'data-presentation-mode' : ''
        }>
          ${html}
        </div>
        ${body}
      </body>
      ${this.generateScriptsForPreview(
        isPresentationMode,
        yamlConfig,
        vscodePreviewPanel,
      )}
      ${scripts}
      <script src="${webviewScript}"></script>
      </html>`;

    return htmlTemplate;
  }

  /**
   * Generate HTML content
   * @param html: this is the final content you want to put.
   * @param yamlConfig: this is the front matter.
   * @param option: HTMLTemplateOption
   */
  public async generateHTMLTemplateForExport(
    html: string,
    yamlConfig = {},
    options: HTMLTemplateOption,
  ): Promise<string> {
    // get `id` and `class`
    const elementId = yamlConfig['id'] || '';
    let elementClass = yamlConfig['class'] || [];
    if (typeof elementClass === 'string') {
      elementClass = [elementClass];
    }
    elementClass = elementClass.join(' ');

    // math style and script
    let mathStyle = '';
    if (
      this.notebook.config.mathRenderingOption === 'MathJax' ||
      this.notebook.config.usePandocParser
    ) {
      // TODO
      const mathJaxConfig = this.notebook.config.mathjaxConfig;
      mathJaxConfig['tex'] = mathJaxConfig['tex'] || {};
      mathJaxConfig['tex'][
        'inlineMath'
      ] = this.notebook.config.mathInlineDelimiters;
      mathJaxConfig['tex'][
        'displayMath'
      ] = this.notebook.config.mathBlockDelimiters;

      if (options.offline) {
        mathStyle = `
        <script type="text/javascript">
          window.MathJax = (${JSON.stringify(mathJaxConfig)});
        </script>
        <script type="text/javascript" async src="${
          this.notebook.config.mathjaxV3ScriptSrc
        }" charset="UTF-8"></script>
        `;
      } else {
        mathStyle = `
        <script type="text/javascript">
          window.MathJax = (${JSON.stringify(mathJaxConfig)});
        </script>
        <script type="text/javascript" async src="${
          this.notebook.config.mathjaxV3ScriptSrc
        }"></script>
        `;
      }
    } else if (this.notebook.config.mathRenderingOption === 'KaTeX') {
      if (options.offline) {
        mathStyle = `<link rel="stylesheet" href="file:///${path.resolve(
          utility.getExtensionDirectoryPath(),
          './dependencies/katex/katex.min.css',
        )}">`;
      } else {
        mathStyle = `<link rel="stylesheet" href="https://${this.notebook.config.jsdelivrCdnHost}/npm/katex@0.16.8/dist/katex.min.css">`;
      }
    } else {
      mathStyle = '';
    }

    // font-awesome
    let fontAwesomeStyle = '';
    if (html.indexOf('<i class="fa ') >= 0) {
      if (options.offline) {
        fontAwesomeStyle = `<link rel="stylesheet" href="file:///${path.resolve(
          utility.getExtensionDirectoryPath(),
          `./dependencies/font-awesome/css/font-awesome.min.css`,
        )}">`;
      } else {
        fontAwesomeStyle = `<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css">`;
      }
    }

    // mermaid
    let mermaidScript = '';
    let mermaidInitScript = '';
    if (html.indexOf(' class="mermaid') >= 0) {
      if (options.offline) {
        mermaidScript = `<script type="text/javascript" src="file:///${path.resolve(
          utility.getExtensionDirectoryPath(),
          './dependencies/mermaid/mermaid.min.js',
        )}" charset="UTF-8"></script>`;
      } else {
        mermaidScript = `<script type="module">
  import mermaid from 'https://${this.notebook.config.jsdelivrCdnHost}/npm/mermaid@10.4.0/dist/mermaid.esm.min.mjs';
</script>`;
      }

      mermaidInitScript += `<script type="module">
// TODO: If ZenUML gets integrated into mermaid in the future,
//      we can remove the following lines.
import zenuml from 'https://${this.notebook.config.jsdelivrCdnHost}/npm/@mermaid-js/mermaid-zenuml@0.1.0/dist/mermaid-zenuml.esm.min.mjs';
await mermaid.registerExternalDiagrams([zenuml])

var MERMAID_CONFIG = (JSON.stringify(${this.notebook.config.mermaidConfig}));
if (typeof MERMAID_CONFIG !== 'undefined') {
  MERMAID_CONFIG.startOnLoad = false
  MERMAID_CONFIG.cloneCssStyles = false
  MERMAID_CONFIG.theme = "${this.notebook.config.mermaidTheme}"
}
mermaid.initialize(MERMAID_CONFIG || {})
if (typeof(window['Reveal']) !== 'undefined') {
  function mermaidRevealHelper(event) {
    var currentSlide = event.currentSlide
    var diagrams = currentSlide.querySelectorAll('.mermaid')
    for (var i = 0; i < diagrams.length; i++) {
      var diagram = diagrams[i]
      if (!diagram.hasAttribute('data-processed')) {
        mermaid.init(null, diagram, ()=> {
          Reveal.slide(event.indexh, event.indexv)
        })
      }
    }
  }
  Reveal.addEventListener('slidechanged', mermaidRevealHelper)
  Reveal.addEventListener('ready', mermaidRevealHelper)
} else {
  await mermaid.run({
    nodes: document.querySelectorAll('.mermaid')
  })
}
</script>`;
    }

    // wavedrom
    let wavedromScript = ``;
    let wavedromInitScript = ``;
    if (html.indexOf(' class="wavedrom') >= 0) {
      if (options.offline) {
        wavedromScript += `<script type="text/javascript" src="file:///${path.resolve(
          utility.getExtensionDirectoryPath(),
          './dependencies/wavedrom/default.js',
        )}" charset="UTF-8"></script>`;
        wavedromScript += `<script type="text/javascript" src="file:///${path.resolve(
          utility.getExtensionDirectoryPath(),
          './dependencies/wavedrom/wavedrom.min.js',
        )}" charset="UTF-8"></script>`;
      } else {
        wavedromScript += `<script type="text/javascript" src="https://cdnjs.cloudflare.com/ajax/libs/wavedrom/2.9.1/skins/default.js"></script>`;
        wavedromScript += `<script type="text/javascript" src="https://cdnjs.cloudflare.com/ajax/libs/wavedrom/2.9.1/wavedrom.min.js"></script>`;
      }
      wavedromInitScript = `<script>WaveDrom.ProcessAll()</script>`;
    }

    // vega and vega-lite with vega-embed
    // https://vega.github.io/vega/usage/#embed
    let vegaScript = ``;
    let vegaInitScript = ``;
    if (
      html.indexOf(' class="vega') >= 0 ||
      html.indexOf(' class="vega-lite') >= 0
    ) {
      dependentLibraryMaterials.forEach(({ key, version }) => {
        vegaScript += options.offline
          ? `<script type="text/javascript" src="file:///${path.resolve(
              utility.getExtensionDirectoryPath(),
              `./dependencies/${key}/${key}.min.js`,
            )}" charset="UTF-8"></script>`
          : `<script type="text/javascript" src="https://${this.notebook.config.jsdelivrCdnHost}/npm/${key}@${version}/build/${key}.js"></script>`;
      });

      vegaInitScript += `<script>
      var vegaEls = document.querySelectorAll('.vega, .vega-lite');
      function reportVegaError(el, error) {
        el.innerHTML = '<pre class="language-text">' + error.toString() + '</pre>'
      }
      for (var i = 0; i < vegaEls.length; i++) {
        const vegaEl = vegaEls[i]
        try {
          var spec = JSON.parse(vegaEl.textContent);
          vegaEmbed(vegaEl, spec, { actions: false, renderer: 'svg' })
          .catch(function(error) {
            reportVegaError(vegaEl, error);
          })
        } catch (error) {
          reportVegaError(vegaEl, error);
        }
      }
      </script>`;
    }

    // presentation
    let presentationScript = '';
    let presentationStyle = '';
    let presentationInitScript = '';
    if (yamlConfig['isPresentationMode']) {
      if (options.offline) {
        presentationScript = `
        <script src='file:///${path.resolve(
          utility.getExtensionDirectoryPath(),
          './dependencies/reveal/lib/js/head.min.js',
        )}'></script>
        <script src='file:///${path.resolve(
          utility.getExtensionDirectoryPath(),
          './dependencies/reveal/js/reveal.js',
        )}'></script>`;
      } else {
        presentationScript = `
        <script src='https://${this.notebook.config.jsdelivrCdnHost}/npm/reveal.js@4.1.0/dist/reveal.js'></script>`;
      }

      const presentationConfig = yamlConfig['presentation'] || {};
      const dependencies = presentationConfig['dependencies'] || [];
      if (presentationConfig['enableSpeakerNotes']) {
        if (options.offline) {
          dependencies.push({
            src: path.resolve(
              utility.getExtensionDirectoryPath(),
              './dependencies/reveal/plugin/notes/notes.js',
            ),
            async: true,
          });
        } else {
          dependencies.push({ src: 'revealjs_deps/notes.js', async: true }); // TODO: copy notes.js file to corresponding folder
        }
      }
      presentationConfig['dependencies'] = dependencies;

      presentationStyle = `
      <style>
      ${await this.fs.readFile(
        path.resolve(
          utility.getExtensionDirectoryPath(),
          './dependencies/reveal/css/reveal.css',
        ),
      )}
      ${
        options.isForPrint
          ? await this.fs.readFile(
              path.resolve(
                utility.getExtensionDirectoryPath(),
                './dependencies/reveal/css/print/pdf.css',
              ),
            )
          : ''
      }
      </style>
      `;
      presentationInitScript = `
      <script>
        Reveal.initialize(${JSON.stringify({
          margin: 0.1,
          ...presentationConfig,
        })})
      </script>
      `;
    }

    // prince
    let princeClass = '';
    if (options.isForPrince) {
      princeClass = 'prince';
    }

    let title = path.basename(this.filePath);
    title = title.slice(0, title.length - path.extname(title).length); // remove '.md'
    if (yamlConfig['title']) {
      title = yamlConfig['title'];
    }

    // prism and preview theme
    let styleCSS = '';
    try {
      // prism *.css
      styleCSS +=
        !this.notebook.config.printBackground &&
        !yamlConfig['print_background'] &&
        !yamlConfig['isPresentationMode']
          ? await this.fs.readFile(
              path.resolve(
                utility.getExtensionDirectoryPath(),
                `./styles/prism_theme/github.css`,
              ),
            )
          : await this.fs.readFile(
              path.resolve(
                utility.getExtensionDirectoryPath(),
                `./styles/prism_theme/${this.getPrismTheme(
                  yamlConfig['isPresentationMode'],
                  yamlConfig,
                )}`,
              ),
            );

      if (yamlConfig['isPresentationMode']) {
        const theme =
          yamlConfig['presentation'] &&
          typeof yamlConfig['presentation'] === 'object' &&
          yamlConfig['presentation']['theme']
            ? yamlConfig['presentation']['theme']
            : this.notebook.config.revealjsTheme;

        if (options.offline) {
          presentationStyle += `<link rel="stylesheet" href="file:///${path.resolve(
            utility.getExtensionDirectoryPath(),
            `./dependencies/reveal/css/theme/${theme}`,
          )}">`;
        } else {
          presentationStyle += `<link rel="stylesheet" href="https://${this.notebook.config.jsdelivrCdnHost}/npm/reveal.js@4.1.0/dist/theme/${theme}">`;
        }
      } else {
        // preview theme
        styleCSS +=
          !this.notebook.config.printBackground &&
          !yamlConfig['print_background']
            ? await this.fs.readFile(
                path.resolve(
                  utility.getExtensionDirectoryPath(),
                  `./styles/preview_theme/github-light.css`,
                ),
              )
            : await this.fs.readFile(
                path.resolve(
                  utility.getExtensionDirectoryPath(),
                  `./styles/preview_theme/${this.notebook.config.previewTheme}`,
                ),
              );
      }

      // style template
      styleCSS += await this.fs.readFile(
        path.resolve(
          utility.getExtensionDirectoryPath(),
          './styles/style-template.css',
        ),
      );

      // markdown-it-admonition
      if (html.indexOf('admonition') > 0) {
        styleCSS += await this.fs.readFile(
          path.resolve(
            utility.getExtensionDirectoryPath(),
            './styles/markdown-it-admonition.css',
          ),
        );
      }
    } catch (e) {
      styleCSS = '';
    }

    // global styles
    const globalStyles = this.notebook.config.globalCss;

    // sidebar toc
    let sidebarTOC = '';
    let sidebarTOCScript = '';
    let sidebarTOCBtn = '';
    if (
      this.notebook.config.enableScriptExecution &&
      !yamlConfig['isPresentationMode'] &&
      !options.isForPrint &&
      (!('html' in yamlConfig) ||
        (yamlConfig['html'] && yamlConfig['html']['toc'] !== false))
    ) {
      // enable sidebar toc by default
      sidebarTOC = `<div class="md-sidebar-toc">${this.tocHTML}</div>`;
      sidebarTOCBtn = '<a id="sidebar-toc-btn">≡</a>';
      // toggle sidebar toc
      // If yamlConfig['html']['toc'], then display sidebar TOC on startup.
      sidebarTOCScript = `
<script>
${
  yamlConfig['html'] && yamlConfig['html']['toc']
    ? `document.body.setAttribute('html-show-sidebar-toc', true)`
    : ''
}
var sidebarTOCBtn = document.getElementById('sidebar-toc-btn')
sidebarTOCBtn.addEventListener('click', function(event) {
  event.stopPropagation()
  if (document.body.hasAttribute('html-show-sidebar-toc')) {
    document.body.removeAttribute('html-show-sidebar-toc')
  } else {
    document.body.setAttribute('html-show-sidebar-toc', true)
  }
})
</script>
      `;
    }

    // task list script
    if (html.indexOf('task-list-item-checkbox') >= 0) {
      const $ = cheerio.load('<div>' + html + '</div>');
      $('.task-list-item-checkbox').each(
        (index: number, elem: CheerioElement) => {
          const $elem = $(elem);
          let $li = $elem.parent();
          if (!$li[0].name.match(/^li$/i)) {
            $li = $li.parent();
          }
          if ($li[0].name.match(/^li$/i)) {
            $li.addClass('task-list-item');
          }
        },
      );
      html = $.html();
    }

    // process styles
    // move @import ''; to the very start.
    let styles = styleCSS + '\n' + globalStyles;
    let imports = '';
    styles = styles.replace(/@import\s+url\(([^)]+)\)\s*;/g, whole => {
      imports += whole + '\n';
      return '';
    });
    styles = imports + styles;

    html = `
  <!DOCTYPE html>
  <html>
    <head>
      <title>${title}</title>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      ${presentationStyle}
      ${mathStyle}
      ${fontAwesomeStyle}
      ${presentationScript}
      ${mermaidScript}
      ${wavedromScript}
      ${vegaScript}
      <style>
      ${styles}
      </style>
    </head>
    <body ${options.isForPrint ? '' : 'for="html-export"'} ${
      yamlConfig['isPresentationMode'] ? 'data-presentation-mode' : ''
    }>
      <div class="crossnote markdown-preview ${princeClass} ${elementClass}" ${
      yamlConfig['isPresentationMode'] ? 'data-presentation-mode' : ''
    } ${elementId ? `id="${elementId}"` : ''}>
      ${html}
      </div>
      ${sidebarTOC}
      ${sidebarTOCBtn}
    </body>
    ${presentationInitScript}
    ${mermaidInitScript}
    ${wavedromInitScript}
    ${vegaInitScript}
    ${sidebarTOCScript}
  </html>
    `;

    if (options.embedLocalImages || options.embedSVG) {
      const $ = cheerio.load(html);
      if (options.embedLocalImages) {
        await enhanceWithEmbeddedLocalImages(
          $,
          this.notebook.config,
          this.resolveFilePath.bind(this),
        );
      }
      if (options.embedSVG) {
        await enhanceWithEmbeddedSvgs(
          $,
          this.notebook.config,
          this.resolveFilePath.bind(this),
        );
      }
      html = $.html();
    }

    return html.trim();
  }

  /**
   * generate HTML file and open it in browser
   */
  public async openInBrowser({ runAllCodeChunks = false }): Promise<void> {
    const inputString = await this.fs.readFile(this.filePath);
    let html;
    let yamlConfig;
    // eslint-disable-next-line prefer-const
    ({ html, yamlConfig } = await this.parseMD(inputString, {
      useRelativeFilePath: false,
      hideFrontMatter: true,
      isForPreview: false,
      runAllCodeChunks,
    }));
    html = await this.generateHTMLTemplateForExport(html, yamlConfig, {
      isForPrint: false,
      isForPrince: false,
      offline: true,
      embedLocalImages: false,
    });
    // create temp file
    const info = await utility.tempOpen({
      prefix: 'crossnote',
      suffix: '.html',
    });

    fs.writeFileSync(info.fd, html);
    // open in browser
    utility.openFile(info.path);
    return;
  }

  /**
   *
   * @param filePath
   * @return dest if success, error if failure
   */
  public async htmlExport({
    offline = false,
    runAllCodeChunks = false,
  }): Promise<string> {
    const inputString = await this.fs.readFile(this.filePath);
    let html;
    let yamlConfig;
    // eslint-disable-next-line prefer-const
    ({ html, yamlConfig } = await this.parseMD(inputString, {
      useRelativeFilePath: true,
      hideFrontMatter: true,
      isForPreview: false,
      runAllCodeChunks,
    }));
    const htmlConfig = yamlConfig['html'] || {};
    if ('offline' in htmlConfig) {
      offline = htmlConfig['offline'];
    }
    const embedLocalImages = htmlConfig['embed_local_images']; // <= embedLocalImages is disabled by default.

    let embedSVG = true; // <= embedSvg is enabled by default.
    if ('embed_svg' in htmlConfig) {
      embedSVG = htmlConfig['embed_svg'];
    }

    let dest = this.filePath;
    const extname = path.extname(dest);
    dest = dest.replace(new RegExp(extname + '$'), '.html');

    html = await this.generateHTMLTemplateForExport(html, yamlConfig, {
      isForPrint: false,
      isForPrince: false,
      embedLocalImages,
      offline,
      embedSVG,
    });

    // presentation speaker notes
    // copy dependency files
    if (
      !offline &&
      html.indexOf('[{"src":"revealjs_deps/notes.js","async":true}]') >= 0
    ) {
      const depsDirName = path.resolve(path.dirname(dest), 'revealjs_deps');
      if (!fs.existsSync(depsDirName)) {
        fs.mkdirSync(depsDirName);
      }
      fs.createReadStream(
        path.resolve(
          utility.getExtensionDirectoryPath(),
          './dependencies/reveal/plugin/notes/notes.js',
        ),
      ).pipe(fs.createWriteStream(path.resolve(depsDirName, 'notes.js')));
      fs.createReadStream(
        path.resolve(
          utility.getExtensionDirectoryPath(),
          './dependencies/reveal/plugin/notes/notes.html',
        ),
      ).pipe(fs.createWriteStream(path.resolve(depsDirName, 'notes.html')));
    }

    await this.fs.writeFile(dest, html);
    return dest;
  }

  /**
   * Chrome (puppeteer) file export
   */
  public async chromeExport({
    fileType = 'pdf',
    runAllCodeChunks = false,
    openFileAfterGeneration = false,
  }): Promise<string> {
    const inputString = await this.fs.readFile(this.filePath);
    let html;
    let yamlConfig;
    // eslint-disable-next-line prefer-const
    ({ html, yamlConfig } = await this.parseMD(inputString, {
      useRelativeFilePath: false,
      hideFrontMatter: true,
      isForPreview: false,
      runAllCodeChunks,
    }));
    let dest = this.filePath;
    const extname = path.extname(dest);
    dest = dest.replace(new RegExp(extname + '$'), '.' + fileType);

    html = await this.generateHTMLTemplateForExport(html, yamlConfig, {
      isForPrint: true,
      isForPrince: false,
      embedLocalImages: false,
      offline: true,
    });

    let browser: Browser | null = null;

    if (!this.notebook.config.chromePath) {
      throw new Error('Chrome path is not set.');
    }

    browser = await puppeteer.launch({
      args: this.notebook.config.puppeteerArgs || [],
      executablePath: this.notebook.config.chromePath,
      headless: true,
    });

    const info = await utility.tempOpen({
      prefix: 'crossnote',
      suffix: '.html',
    });
    fs.writeFileSync(info.fd, html);

    const page = await browser.newPage();
    const loadPath =
      'file:///' +
      info.path +
      (yamlConfig['isPresentationMode'] ? '?print-pdf' : '');
    await page.goto(loadPath);

    const puppeteerConfig = {
      path: dest,
      ...(yamlConfig['isPresentationMode']
        ? {}
        : {
            margin: {
              top: '1cm',
              bottom: '1cm',
              left: '1cm',
              right: '1cm',
            },
          }),
      printBackground: this.notebook.config.printBackground,
      ...(yamlConfig['chrome'] || yamlConfig['puppeteer'] || {}),
    };

    // wait for timeout
    let timeout = 0;
    if (yamlConfig['chrome'] && yamlConfig['chrome']['timeout']) {
      timeout = yamlConfig['chrome']['timeout'];
    } else if (yamlConfig['puppeteer'] && yamlConfig['puppeteer']['timeout']) {
      timeout = yamlConfig['puppeteer']['timeout'];
    }
    if (timeout && typeof timeout === 'number') {
      await page.waitForTimeout(timeout);
    } else if (
      this.notebook.config.puppeteerWaitForTimeout &&
      this.notebook.config.puppeteerWaitForTimeout > 0
    ) {
      await page.waitForTimeout(this.notebook.config.puppeteerWaitForTimeout);
    }

    if (fileType === 'pdf') {
      await page.pdf(puppeteerConfig);
    } else {
      puppeteerConfig['fullPage'] = true; // <= set to fullPage by default
      await page.screenshot(puppeteerConfig);
    }
    browser.close();

    if (openFileAfterGeneration) {
      utility.openFile(dest);
    }
    return dest;
  }

  /**
   * prince pdf file export
   * @return dest if success, error if failure
   */
  public async princeExport({
    runAllCodeChunks = false,
    openFileAfterGeneration = false,
  }): Promise<string> {
    const inputString = await this.fs.readFile(this.filePath);
    let html;
    let yamlConfig;
    // eslint-disable-next-line prefer-const
    ({ html, yamlConfig } = await this.parseMD(inputString, {
      useRelativeFilePath: false,
      hideFrontMatter: true,
      isForPreview: false,
      runAllCodeChunks,
    }));
    let dest = this.filePath;
    const extname = path.extname(dest);
    dest = dest.replace(new RegExp(extname + '$'), '.pdf');

    html = await this.generateHTMLTemplateForExport(html, yamlConfig, {
      isForPrint: true,
      isForPrince: true,
      embedLocalImages: false,
      offline: true,
    });

    const info = await utility.tempOpen({
      prefix: 'crossnote',
      suffix: '.html',
    });
    fs.writeFileSync(info.fd, html);

    if (yamlConfig['isPresentationMode']) {
      const url = 'file:///' + info.path + '?print-pdf';
      return url;
    } else {
      await princeConvert(info.path, dest);

      //  open pdf
      if (openFileAfterGeneration) {
        utility.openFile(dest);
      }
      return dest;
    }
  }

  private async eBookDownloadImages($, dest): Promise<string[]> {
    const imagesToDownload: Cheerio[] = [];
    if (path.extname(dest) === '.epub' || path.extname('dest') === '.mobi') {
      $('img').each((offset, img) => {
        const $img = $(img);
        const src = $img.attr('src') || '';
        if (src.match(/^https?:\/\//)) {
          imagesToDownload.push($img);
        }
      });
    }

    const asyncFunctions = imagesToDownload.map($img => {
      return new Promise<string>(resolve => {
        const httpSrc = $img.attr('src');
        let savePath =
          Math.random()
            .toString(36)
            .substr(2, 9) +
          '_' +
          path.basename(httpSrc);
        savePath = path.resolve(this.fileDirectoryPath, savePath);

        const stream = request(httpSrc).pipe(fs.createWriteStream(savePath));

        stream.on('finish', () => {
          $img.attr('src', 'file:///' + savePath);
          return resolve(savePath);
        });
      });
    });

    return Promise.all(asyncFunctions);
  }

  /**
   *
   *
   * @return dest if success, error if failure
   */
  public async eBookExport({
    fileType = 'epub',
    runAllCodeChunks = false,
  }: {
    /**
     * fileType: 'epub', 'pdf', 'mobi' or 'html'
     */
    fileType: string;
    runAllCodeChunks?: boolean;
  }): Promise<string> {
    const inputString = await this.fs.readFile(this.filePath);
    const emojiToSvg = fileType === 'pdf';
    let html;
    let yamlConfig;
    // eslint-disable-next-line prefer-const
    ({ html, yamlConfig } = await this.parseMD(inputString, {
      useRelativeFilePath: false,
      hideFrontMatter: true,
      isForPreview: false,
      runAllCodeChunks,
      emojiToSvg,
    }));

    let dest = this.filePath;
    const extname = path.extname(dest);
    dest = dest.replace(
      new RegExp(extname + '$'),
      '.' + fileType.toLowerCase(),
    );

    const ebookConfig = yamlConfig['ebook'] || {};
    if (!ebookConfig) {
      throw new Error(
        'eBook config not found. Please insert ebook front-matter to your markdown file.',
      );
    }

    if (ebookConfig['cover']) {
      // change cover to absolute path if necessary
      const cover = ebookConfig['cover'];
      ebookConfig['cover'] = utility.removeFileProtocol(
        this.resolveFilePath(cover, false),
      );
    }

    let $ = cheerio.load(`<div>${html}</div>`);
    const tocStructure: {
      level: number;
      filePath: string;
      heading: string;
      id: string;
    }[] = [];
    const headingIdGenerator = new HeadingIdGenerator();
    const $toc = $('div > ul').last();
    if ($toc.length) {
      if (ebookConfig['include_toc'] === false) {
        // remove itself and the heading ahead
        const $prev = $toc.prev();
        if ($prev.length && $prev[0].name.match(/^h\d$/i)) {
          $prev.remove();
        }
      }

      $('h1, h2, h3, h4, h5, h6').each((offset, h) => {
        const $h = $(h);
        const level = parseInt($h[0].name.slice(1), 10) - 1;

        // $h.attr('id', id)
        $h.attr('ebook-toc-level-' + (level + 1), '');
        $h.attr('heading', $h.html());
      });

      getStructure($toc, 0); // analyze TOC

      if (ebookConfig['include_toc'] === false) {
        // remove itself and the heading ahead
        $toc.remove();
      }
    }

    // load the last ul as TOC, analyze toc links
    function getStructure($ul, level) {
      $ul.children('li').each((offset, li) => {
        const $li = $(li);
        const $a = $li.children('a').first();

        if (!$a.length) {
          if ($li.children().length >= 1) {
            getStructure($li.children().last(), level + 1);
          }
          return;
        }

        const filePath = decodeURIComponent($a.attr('href')); // markdown file path
        const heading = $a.html() ?? '';
        const id = headingIdGenerator.generateId(`ebook-heading-` + heading); // "ebook-heading-id-" + headingOffset;

        tocStructure.push({ level, filePath, heading, id });

        $a.attr('href', '#' + id); // change id
        if ($li.children().length > 1) {
          getStructure($li.children().last(), level + 1);
        }
      });
    }

    // load each markdown files according to `tocStructure`
    const asyncFunctions = tocStructure.map(
      ({ heading, id, level, filePath }, offset) => {
        return new Promise((resolve, reject) => {
          filePath = utility.removeFileProtocol(filePath);
          if (filePath.match(/^https?:\/\//)) {
            return resolve({ heading, id, level, filePath, html: '', offset });
          }
          fs.readFile(filePath, { encoding: 'utf-8' }, (error, text) => {
            if (error) {
              return reject(error.toString());
            }

            // Fix image paths that are relative to the child documents
            const rootPath = path.dirname(this.filePath);
            text = text.replace(
              /(!\[[^\]]*\]\()(\.[^)\s]*)/g,
              (whole, openTag, imageLink) => {
                const fullPath = path.resolve(
                  path.dirname(filePath),
                  imageLink,
                );
                const relativePath = path.relative(rootPath, fullPath);
                return openTag + relativePath;
              },
            );
            this.parseMD(text, {
              useRelativeFilePath: false,
              isForPreview: false,
              hideFrontMatter: true,
              emojiToSvg,
              fileDirectoryPath: path.dirname(filePath),
              /* tslint:disable-next-line:no-shadowed-variable */
            }).then(({ html }) => {
              return resolve({ heading, id, level, filePath, html, offset });
            });
          });
        });
      },
    );

    let outputHTML = $.html().replace(/^<div>(.+)<\/div>$/, '$1');
    let results = (await Promise.all(asyncFunctions)) as {
      heading: string;
      id: string;
      level: number;
      filePath: string;
      html?: string;
    }[];
    results = results.sort((a, b) => a['offset'] - b['offset']);

    /* tslint:disable-next-line:no-shadowed-variable */
    results.forEach(({ heading, id, level, html }) => {
      /* tslint:disable-next-line:no-shadowed-variable */

      const $$ = cheerio.load(`<div>${html}</div>`);
      $$('a').each((index, a) => {
        const $a = $$(a);
        const href = $a.attr('href');
        if (href.startsWith('file://')) {
          results.forEach(result => {
            if (result.filePath === utility.removeFileProtocol(href)) {
              $a.attr('href', '#' + result.id);
            }
          });
        }
      });

      outputHTML += `<div id="${id}" ebook-toc-level-${level +
        1} heading="${heading}">${$$.html()}</div>`; // append new content
    });

    $ = cheerio.load(outputHTML);
    const downloadedImagePaths = await this.eBookDownloadImages($, dest);

    // convert image to base64 if output html
    if (path.extname(dest) === '.html') {
      // check cover
      if (ebookConfig['cover']) {
        const cover =
          ebookConfig['cover'][0] === '/'
            ? 'file:///' + ebookConfig['cover']
            : ebookConfig['cover'];
        $(':root')
          .children()
          .first()
          .prepend(
            `<img style="display:block; margin-bottom: 24px;" src="${cover}">`,
          );
      }

      await enhanceWithEmbeddedLocalImages(
        $,
        this.notebook.config,
        this.resolveFilePath.bind(this),
      );
    }

    // retrieve html
    outputHTML = $.html();
    const title = ebookConfig['title'] || 'no title';

    // math
    let mathStyle = '';
    if (outputHTML.indexOf('class="katex"') > 0) {
      if (
        path.extname(dest) === '.html' &&
        ebookConfig['html'] &&
        ebookConfig['html'].cdn
      ) {
        mathStyle = `<link rel="stylesheet" href="https://${this.notebook.config.jsdelivrCdnHost}/npm/katex@0.16.8/dist/katex.min.css">`;
      } else {
        mathStyle = `<link rel="stylesheet" href="file:///${path.resolve(
          utility.getExtensionDirectoryPath(),
          './dependencies/katex/katex.min.css',
        )}">`;
      }
    }

    // prism and preview theme
    let styleCSS = '';
    try {
      const styles = await Promise.all([
        // style template
        await this.fs.readFile(
          path.resolve(
            utility.getExtensionDirectoryPath(),
            './styles/style-template.css',
          ),
        ),
        // prism *.css
        await this.fs.readFile(
          path.resolve(
            utility.getExtensionDirectoryPath(),
            `./styles/prism_theme/${
              /*this.getPrismTheme(false)*/ MarkdownEngine.AutoPrismThemeMap[
                ebookConfig['theme'] || this.notebook.config.previewTheme
              ]
            }`,
          ),
        ),
        // twemoji css style
        await this.fs.readFile(
          path.resolve(
            utility.getExtensionDirectoryPath(),
            './styles/twemoji.css',
          ),
        ),
        // preview theme
        await this.fs.readFile(
          path.resolve(
            utility.getExtensionDirectoryPath(),
            `./styles/preview_theme/${ebookConfig['theme'] ||
              this.notebook.config.previewTheme}`,
          ),
        ),
        // markdown-it-admonition
        outputHTML.indexOf('admonition') > 0
          ? await this.fs.readFile(
              path.resolve(
                utility.getExtensionDirectoryPath(),
                './styles/markdown-it-admonition.css',
              ),
            )
          : '',
      ]);
      styleCSS = styles.join('');
    } catch (e) {
      styleCSS = '';
    }

    // global styles
    let globalStyles = '';
    try {
      globalStyles = this.notebook.config.globalCss;
    } catch (error) {
      // ignore it
    }

    // only use github-light style for ebook
    html = `
<!DOCTYPE html>
<html>
  <head>
    <title>${title}</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
    ${styleCSS}
    ${globalStyles}
    </style>
    ${mathStyle}
  </head>
  <body ${path.extname(dest) === '.html' ? 'for="html-export"' : ''}>
    <div class="crossnote markdown-preview">
    ${outputHTML}
    </div>
  </body>
</html>
`;

    // save as html
    if (path.extname(dest) === '.html') {
      await this.fs.writeFile(dest, html);
      return dest;
    }

    // this function will be called later
    function deleteDownloadedImages() {
      downloadedImagePaths.forEach(imagePath => {
        fs.unlink(imagePath, () => {
          return;
        });
      });
    }

    try {
      const info = await utility.tempOpen({
        prefix: 'crossnote',
        suffix: '.html',
      });
      fs.writeFileSync(info.fd, html);
      await ebookConvert(info.path, dest, ebookConfig);
      deleteDownloadedImages();
      return dest;
    } catch (error) {
      deleteDownloadedImages();
      throw error;
    }
  }

  /**
   * pandoc export
   */
  public async pandocExport({
    runAllCodeChunks = false,
    openFileAfterGeneration = false,
  }): Promise<string> {
    let inputString = await this.fs.readFile(this.filePath);

    if (this.notebook.config.parserConfig['onWillParseMarkdown']) {
      inputString = await this.notebook.config.parserConfig[
        'onWillParseMarkdown'
      ](inputString);
    }

    if (runAllCodeChunks) {
      // this line of code is only used to get this.codeChunksData
      await this.parseMD(inputString, {
        useRelativeFilePath: true,
        isForPreview: false,
        hideFrontMatter: false,
        runAllCodeChunks,
      });
    }

    let config = {};

    if (inputString.startsWith('---')) {
      const endFrontMatterOffset = inputString.indexOf('\n---');
      if (endFrontMatterOffset > 0) {
        const frontMatterString = inputString.slice(
          0,
          endFrontMatterOffset + 4,
        );
        config = this.processFrontMatter(frontMatterString, false).data;
      }
    }

    const outputFilePath = await pandocConvert(
      inputString,
      {
        fileDirectoryPath: this.fileDirectoryPath,
        projectDirectoryPath: this.projectDirectoryPath,
        sourceFilePath: this.filePath,
        protocolsWhiteListRegExp: this.protocolsWhiteListRegExp,
        // deleteImages: true,
        filesCache: this.filesCache,
        codeChunksData: this.codeChunksData,
        graphsCache: this.graphsCache,
        imageDirectoryPath: this.notebook.config.imageFolderPath,
        pandocMarkdownFlavor: this.notebook.config.pandocMarkdownFlavor,
        pandocPath: this.notebook.config.pandocPath,
        latexEngine: this.notebook.config.latexEngine,
        imageMagickPath: this.notebook.config.imageMagickPath,
        mermaidTheme: this.notebook.config.mermaidTheme,
        plantumlServer: this.notebook.config.plantumlServer,
        plantumlJarPath: this.notebook.config.plantumlJarPath,
        onWillTransformMarkdown: this.notebook.config.parserConfig[
          'onWillTransformMarkdown'
        ],
        onDidTransformMarkdown: this.notebook.config.parserConfig[
          'onDidTransformMarkdown'
        ],
      },
      config,
    );

    if (openFileAfterGeneration) {
      utility.openFile(outputFilePath);
    }
    return outputFilePath;
  }

  /**
   * markdown(gfm) export
   */
  public async markdownExport({ runAllCodeChunks = false }): Promise<string> {
    let inputString = await this.fs.readFile(this.filePath);

    if (runAllCodeChunks) {
      // this line of code is only used to get this.codeChunksData
      await this.parseMD(inputString, {
        useRelativeFilePath: true,
        isForPreview: false,
        hideFrontMatter: false,
        runAllCodeChunks,
      });
    }

    let config = {};

    if (inputString.startsWith('---')) {
      const endFrontMatterOffset = inputString.indexOf('\n---');
      if (endFrontMatterOffset > 0) {
        const frontMatterString = inputString.slice(
          0,
          endFrontMatterOffset + 4,
        );
        inputString = inputString.replace(frontMatterString, ''); // remove front matter
        config = this.processFrontMatter(frontMatterString, false).data;
      }
    }

    /**
     * markdownConfig has the following properties:
     *     path:                        destination of the output file
     *     image_dir:                   where to save the image file
     *     use_absolute_image_path:      as the name shows.
     *     ignore_from_front_matter:    default is true.
     */
    let markdownConfig = {};
    if (config['markdown']) {
      markdownConfig = { ...config['markdown'] };
    }

    if (!markdownConfig['image_dir']) {
      markdownConfig['image_dir'] = this.notebook.config.imageFolderPath;
    }

    if (!markdownConfig['path']) {
      if (this.filePath.match(/\.src\./)) {
        markdownConfig['path'] = this.filePath.replace(/\.src\./, '.');
      } else {
        markdownConfig['path'] = this.filePath.replace(
          new RegExp(path.extname(this.filePath)),
          '_' + path.extname(this.filePath),
        );
      }
      markdownConfig['path'] = path.basename(markdownConfig['path']);
    }

    // ignore_from_front_matter is `true` by default
    if (
      markdownConfig['ignore_from_front_matter'] ||
      !('ignore_from_front_matter' in markdownConfig)
    ) {
      // delete markdown config front-matter from the top front matter
      delete config['markdown'];
    }
    if (config['export_on_save']) {
      delete config['export_on_save'];
    }

    // put front-matter back
    if (Object.keys(config).length) {
      inputString = '---\n' + YAML.stringify(config) + '---\n' + inputString;
    }

    return await markdownConvert(
      inputString,
      {
        projectDirectoryPath: this.projectDirectoryPath,
        fileDirectoryPath: this.fileDirectoryPath,
        protocolsWhiteListRegExp: this.protocolsWhiteListRegExp,
        filesCache: this.filesCache,
        mathRenderingOption: this.notebook.config.mathRenderingOption,
        mathInlineDelimiters: this.notebook.config.mathInlineDelimiters,
        mathBlockDelimiters: this.notebook.config.mathBlockDelimiters,
        mathRenderingOnlineService: this.notebook.config
          .mathRenderingOnlineService,
        codeChunksData: this.codeChunksData,
        graphsCache: this.graphsCache,
        usePandocParser: this.notebook.config.usePandocParser,
        imageMagickPath: this.notebook.config.imageMagickPath,
        mermaidTheme: this.notebook.config.mermaidTheme,
        plantumlServer: this.notebook.config.plantumlServer,
        plantumlJarPath: this.notebook.config.plantumlJarPath,
        onWillTransformMarkdown: this.notebook.config.parserConfig[
          'onWillTransformMarkdown'
        ],
        onDidTransformMarkdown: this.notebook.config.parserConfig[
          'onDidTransformMarkdown'
        ],
      },
      markdownConfig,
    );
  }

  /**
   * Eg
   * ---
   * export_on_save:
   *    html: true
   *    prince: true
   *    puppeteer | chrome: true  // or pdf | jpeg | png
   *    pandoc: true
   *    ebook: true      // or epub | pdf | html | mobi
   *    markdown: true
   * ---
   * @param data
   */
  private exportOnSave(data: JsonObject) {
    for (const exporter in data) {
      if (exporter === 'html') {
        this.htmlExport({});
      } else if (exporter === 'prince') {
        this.princeExport({ openFileAfterGeneration: false });
      } else if (exporter === 'puppeteer' || exporter === 'chrome') {
        const fileTypes = data[exporter];
        let func = this.chromeExport;
        func = func.bind(this);

        if (fileTypes === true) {
          func({ fileType: 'pdf', openFileAfterGeneration: false });
        } else if (typeof fileTypes === 'string') {
          func({ fileType: fileTypes, openFileAfterGeneration: false });
        } else if (fileTypes instanceof Array) {
          fileTypes.forEach((fileType: string) => {
            func({ fileType, openFileAfterGeneration: false });
          });
        }
      } else if (exporter === 'pandoc') {
        this.pandocExport({ openFileAfterGeneration: false });
      } else if (exporter === 'ebook') {
        const fileTypes = data[exporter];
        if (fileTypes === true) {
          this.eBookExport({ fileType: 'epub' });
        } else if (typeof fileTypes === 'string') {
          this.eBookExport({ fileType: fileTypes });
        } else if (fileTypes instanceof Array) {
          fileTypes.forEach((fileType: string) => {
            this.eBookExport({ fileType });
          });
        }
      }
    }
  }

  /**
   *
   * @param filePath
   * @param relative: whether to use the path relative to filePath or not.
   */
  private resolveFilePath(
    filePath: string = '',
    relative: boolean,
    fileDirectoryPath = '',
  ) {
    if (
      filePath.match(this.protocolsWhiteListRegExp) ||
      filePath.startsWith('data:image/') ||
      filePath[0] === '#'
    ) {
      return filePath;
    } else if (filePath[0] === '/') {
      if (relative) {
        return path.relative(
          fileDirectoryPath || this.fileDirectoryPath,
          path.resolve(this.projectDirectoryPath, '.' + filePath),
        );
      } else {
        return utility.addFileProtocol(
          path.resolve(this.projectDirectoryPath, '.' + filePath),
          this.vscodePreviewPanel,
        );
      }
    } else {
      if (relative) {
        return filePath;
      } else {
        return utility.addFileProtocol(
          path.resolve(fileDirectoryPath || this.fileDirectoryPath, filePath),
          this.vscodePreviewPanel,
        );
      }
    }
  }

  /**
   * return this.cachedHTML
   */
  /*
  public getCachedHTML() {
    return this.cachedHTML
  }
  */

  /**
   * clearCaches will clear filesCache, codeChunksData, graphsCache
   */
  public clearCaches() {
    this.filesCache = {};
    this.codeChunksData = {};
    this.graphsCache = {};
  }

  private frontMatterToTable(arg) {
    if (arg instanceof Array) {
      let tbody = '<tbody><tr>';
      arg.forEach(
        item => (tbody += `<td>${this.frontMatterToTable(item)}</td>`),
      );
      tbody += '</tr></tbody>';
      return `<table>${tbody}</table>`;
    } else if (typeof arg === 'object') {
      let thead = '<thead><tr>';
      let tbody = '<tbody><tr>';
      for (const key in arg) {
        // eslint-disable-next-line no-prototype-builtins
        if (arg.hasOwnProperty(key)) {
          thead += `<th>${key}</th>`;
          tbody += `<td>${this.frontMatterToTable(arg[key])}</td>`;
        }
      }
      thead += '</tr></thead>';
      tbody += '</tr></tbody>';

      return `<table>${thead}${tbody}</table>`;
    } else {
      return arg;
    }
  }

  /**
   * process input string, skip front-matter
   * if usePandocParser. return {
   *      content: frontMatterString
   * }
   * else if display table. return {
   *      table: string of <table>...</table> generated from data
   *      content: ''
   * }
   * else return {
   *      content: replace ---\n with ```yaml
   * }
   *
   */
  private processFrontMatter(
    frontMatterString: string,
    hideFrontMatter = false,
  ) {
    if (frontMatterString) {
      const data = utility.parseYAML(frontMatterString);

      if (this.notebook.config.usePandocParser) {
        // use pandoc parser, so don't change inputString
        return { content: frontMatterString, table: '', data: data || {} };
      } else if (
        hideFrontMatter ||
        (this.notebook.config.frontMatterRenderingOption ?? '')[0] === 'n'
      ) {
        // hide
        return { content: '', table: '', data };
      } else if (
        (this.notebook.config.frontMatterRenderingOption ?? '')[0] === 't'
      ) {
        // table
        // to table
        let table;
        if (typeof data === 'object') {
          table = this.frontMatterToTable(data);
        } else {
          table = '<pre>Failed to parse YAML.</pre>';
        }

        return { content: '', table, data };
      } else {
        // # if frontMatterRenderingOption[0] == 'c' # code block
        const content = frontMatterString
          .replace(/^---/, '```yaml')
          .replace(/\n---$/, '\n```\n');
        return { content, table: '', data };
      }
    } else {
      return { content: frontMatterString, table: '', data: {} };
    }
  }

  /**
   * Parse `html` to generate slides
   */
  private parseSlides(
    html: string,
    slideConfigs: JsonObject[],
    useRelativeFilePath: boolean,
  ) {
    let slides = html.split('<p>[CROSSNOTESLIDE]</p>');
    const before = slides[0];
    slides = slides.slice(1);

    let output = '';
    let i = 0;
    let h = -1; // horizontal
    let v = 0; // vertical
    while (i < slides.length) {
      const slide = slides[i];
      const slideConfig = slideConfigs[i];

      // resolve paths in slideConfig
      if ('data-background-image' in slideConfig) {
        slideConfig['data-background-image'] = this.resolveFilePath(
          slideConfig['data-background-image'] as string,
          useRelativeFilePath,
        );
      }
      if ('data-background-video' in slideConfig) {
        slideConfig['data-background-video'] = this.resolveFilePath(
          slideConfig['data-background-video'] as string,
          useRelativeFilePath,
        );
      }
      if ('data-background-iframe' in slideConfig) {
        slideConfig['data-background-iframe'] = this.resolveFilePath(
          slideConfig['data-background-iframe'] as string,
          useRelativeFilePath,
        );
      }

      const attrString = stringifyBlockAttributes(slideConfig, false); // parseAttrString(slideConfig)
      const classString = slideConfig['class'] || '';
      const idString = slideConfig['id'] ? `id="${slideConfig['id']}"` : '';

      if (!slideConfig['vertical']) {
        h += 1;
        if (i > 0 && slideConfigs[i - 1]['vertical']) {
          // end of vertical slides
          output += '</section>';
          v = 0;
        }
        if (i < slides.length - 1 && slideConfigs[i + 1]['vertical']) {
          // start of vertical slides
          output += '<section>';
        }
      } else {
        // vertical slide
        v += 1;
      }

      output += `<section ${attrString} ${idString}  class="slide ${classString}" data-line="${slideConfig['lineNo']}" data-h="${h}" data-v="${v}">${slide}</section>`;
      i += 1;
    }
    if (i > 0 && slideConfigs[i - 1]['vertical']) {
      // end of vertical slides
      output += '</section>';
    }

    // check list item attribtues
    // issue: https://github.com/shd101wyy/markdown-preview-enhanced/issues/559
    const $ = cheerio.load(output);
    $('li').each((j, elem) => {
      const $elem = $(elem);
      const html2 = ($elem.html() ?? '').trim().split('\n')[0];
      const attributeMatch = html2.match(/<!--(.+?)-->/);
      if (attributeMatch) {
        const attributes = attributeMatch[1].replace(/\.element:/, '').trim();
        const attrObj = parseBlockAttributes(attributes);
        for (const key in attrObj) {
          // eslint-disable-next-line no-prototype-builtins
          if (attrObj.hasOwnProperty(key)) {
            $elem.attr(key, attrObj[key]);
          }
        }
      }
    });

    return `
    <div style="display:none;">${before}</div>
    <div class="reveal">
      <div class="slides">
        ${$.html()}
      </div>
    </div>
    `;
  }

  public async pandocRender(
    text: string = '',
    args: string[],
  ): Promise<string> {
    let mathRenderer;
    switch (this.notebook.config.mathRenderingOption) {
      case 'MathJax':
        mathRenderer = '--mathjax';
        break;
      case 'KaTeX':
        mathRenderer = '--katex';
        break;
      default:
        mathRenderer = '';
    }
    args = args || [];
    args = [
      '--from=' + this.notebook.config.pandocMarkdownFlavor, // -tex_math_dollars doesn't work properly
      '--to=html',
      mathRenderer,
    ]
      .concat(args)
      .filter(arg => arg.length);

    /*
      convert pandoc code block to markdown-it code block
    */
    let outputString = '';
    const lines = text.split('\n');
    let i = 0;
    let inCodeBlock = false;
    let codeBlockSpacesAhead = 0;
    while (i < lines.length) {
      let line = lines[i];
      const match = line.match(/(^\s*)```/);
      if (match) {
        inCodeBlock = !inCodeBlock;

        if (inCodeBlock) {
          let info = line.slice(match[0].length).trim();
          if (!info) {
            info = 'text';
          }
          const parsedInfo = parseBlockInfo(info);
          const normalizedInfo = normalizeBlockInfo(parsedInfo);

          codeBlockSpacesAhead = match[1].length;
          outputString += `${
            match[1]
          }\`\`\`{.text data-role="codeBlock" data-info="${escape(
            info,
          )}" data-parsed-info="${escape(
            JSON.stringify(parsedInfo),
          )}" data-normalized-info="${escape(
            JSON.stringify(normalizedInfo),
          )}"}\n`;
        } else if (match[1].length === codeBlockSpacesAhead) {
          outputString += `${match[1]}\`\`\`\n`;
        } else {
          inCodeBlock = !inCodeBlock;
          outputString += line + '\n';
        }

        i += 1;
        continue;
      }

      if (line.match(/^\[toc\]/i) && !inCodeBlock) {
        line = '[CROSSNOTETOC]';
      }

      outputString += line + '\n';
      i += 1;
    }

    const pandocPath = this.notebook.config.pandocPath;
    return await new Promise<string>((resolve, reject) => {
      try {
        const program = execFile(
          pandocPath,
          args,
          { cwd: this.fileDirectoryPath, maxBuffer: Infinity },
          (error, stdout, stderr) => {
            if (error) {
              return reject(error);
            } else if (stderr) {
              return resolve('<pre>' + stderr + '</pre>' + stdout);
            } else {
              return resolve(stdout);
            }
          },
        );
        program.stdin?.end(outputString, 'utf-8');
      } catch (error) {
        let errorMessage = error.toString();
        if (errorMessage.indexOf('Error: write EPIPE') >= 0) {
          errorMessage = `"pandoc" is required to be installed.\nCheck "http://pandoc.org/installing.html" website.`;
        }
        return reject(errorMessage);
      }
    });
  }

  public async parseMD(
    inputString: string,
    options: MarkdownEngineRenderOption,
  ): Promise<MarkdownEngineOutput> {
    if (!inputString) {
      inputString = await this.fs.readFile(this.filePath);
    }

    this.vscodePreviewPanel = options.vscodePreviewPanel;

    if (this.notebook.config.parserConfig['onWillParseMarkdown']) {
      inputString = await this.notebook.config.parserConfig[
        'onWillParseMarkdown'
      ](inputString);
    }

    if (this.notebook.config.parserConfig['onWillTransformMarkdown']) {
      inputString = await this.notebook.config.parserConfig[
        'onWillTransformMarkdown'
      ](inputString);
    }

    // import external files and insert anchors if necessary
    let outputString;
    let slideConfigs;
    let tocBracketEnabled;
    let JSAndCssFiles;
    let headings;
    let frontMatterString;
    ({
      outputString,
      // eslint-disable-next-line prefer-const
      slideConfigs,
      // eslint-disable-next-line prefer-const
      tocBracketEnabled,
      JSAndCssFiles,
      // eslint-disable-next-line prefer-const
      headings,
      // eslint-disable-next-line prefer-const
      frontMatterString,
    } = await transformMarkdown(inputString, {
      fileDirectoryPath: options.fileDirectoryPath || this.fileDirectoryPath,
      projectDirectoryPath: this.projectDirectoryPath,
      forPreview: options.isForPreview,
      protocolsWhiteListRegExp: this.protocolsWhiteListRegExp,
      useRelativeFilePath: options.useRelativeFilePath,
      filesCache: this.filesCache,
      usePandocParser: this.notebook.config.usePandocParser,
      onWillTransformMarkdown: this.notebook.config.parserConfig[
        'onWillTransformMarkdown'
      ],
      onDidTransformMarkdown: this.notebook.config.parserConfig[
        'onDidTransformMarkdown'
      ],
    }));

    if (this.notebook.config.parserConfig['onDidTransformMarkdown']) {
      outputString = await this.notebook.config.parserConfig[
        'onDidTransformMarkdown'
      ](outputString);
    }

    // process front-matter
    const fm = this.processFrontMatter(
      frontMatterString,
      options.hideFrontMatter,
    );
    const frontMatterTable = fm.table;
    let yamlConfig = fm.data || {};
    if (typeof yamlConfig !== 'object') {
      yamlConfig = {};
    }

    outputString = fm.content + outputString;

    /**
     * render markdown to html
     */
    let html;
    if (this.notebook.config.usePandocParser) {
      // pandoc
      try {
        let args = (yamlConfig['pandoc_args'] || []) as string[];
        if (!(args instanceof Array)) {
          args = [];
        }

        // check bibliography
        const noDefaultsOrCiteProc =
          args.find((el: string) => {
            return el.includes('pandoc-citeproc') || el.includes('--defaults');
          }) === undefined;

        if (
          noDefaultsOrCiteProc &&
          (yamlConfig['bibliography'] || yamlConfig['references'])
        ) {
          args.push('--citeproc');
        }

        args = this.notebook.config.pandocArguments.concat(args);

        html = await this.pandocRender(outputString, args);
      } catch (error) {
        html = `<pre>${error}</pre>`;
      }
    } else {
      // markdown-it
      html = this.notebook.md.render(outputString);
    }

    /**
     * render tocHTML for [TOC] and sidebar TOC
     */
    // if (!utility.isArrayEqual(headings, this.headings)) { // <== this code is wrong, as it will always be true...
    const tocConfig = yamlConfig['toc'] || {};
    const depthFrom = tocConfig['depth_from'] || 1;
    const depthTo = tocConfig['depth_to'] || 6;
    const ordered = tocConfig['ordered'];

    // const tocObject = toc(headings, { ordered, depthFrom, depthTo, tab: "  " });
    // this.tocHTML = this.notebook.md.render(tocObject.content);

    // Collaposible ToC
    this.tocHTML = generateSidebarToCHTML(
      headings,
      this.notebook.md.render.bind(this.notebook.md),
      { ordered, depthFrom, depthTo, tab: '  ' },
    );

    // }
    this.headings = headings; // reset headings information

    if (tocBracketEnabled) {
      // [TOC]
      html = html.replace(/^\s*<p>\[CROSSNOTETOC\]<\/p>\s*/gm, this.tocHTML);
    }

    /**
     * resolve image paths and render code block.
     */
    const $ = cheerio.load(html);
    await enhanceWithFencedMath(
      $,
      this.notebook.config.mathRenderingOption,
      this.notebook.config.mathBlockDelimiters,
      this.notebook.config.katexConfig,
    );
    await enhanceWithFencedDiagrams({
      $,
      graphsCache: this.graphsCache,
      fileDirectoryPath: options.fileDirectoryPath || this.fileDirectoryPath,
      imageDirectoryPath: removeFileProtocol(
        this.resolveFilePath(this.notebook.config.imageFolderPath, false),
      ),
      plantumlServer: this.notebook.config.plantumlServer,
      plantumlJarPath: this.notebook.config.plantumlJarPath,
      kirokiServer: this.notebook.config.krokiServer,
    });
    await enhanceWithFencedCodeChunks(
      $,
      this.codeChunksData,
      options,
      this.generateRunOptions(),
    );
    await enhanceWithCodeBlockStyling($);
    await enhanceWithResolvedImagePaths(
      $,
      options,
      this.resolveFilePath.bind(this),
      this.notebook.config.usePandocParser,
    );

    if (this.notebook.config.enableExtendedTableSyntax) {
      // extend table
      await enhanceWithExtendedTableSyntax($);
    }

    // Disable this function because of issue:
    // https://github.com/shd101wyy/markdown-preview-enhanced/issues/1287
    // if (options.emojiToSvg) {
    //   enhanceWithEmojiToSvg($);
    // }

    html = frontMatterTable + $('head').html() + $('body').html(); // cheerio $.html() will add <html><head></head><body>$html</body></html>, so we hack it by select body first.

    /**
     * check slides
     */
    if (slideConfigs.length) {
      html = this.parseSlides(html, slideConfigs, options.useRelativeFilePath);
      if (yamlConfig) {
        yamlConfig['isPresentationMode'] = true; // mark as presentation mode
      }
    }

    if (this.notebook.config.parserConfig['onDidParseMarkdown']) {
      html = await this.notebook.config.parserConfig['onDidParseMarkdown'](
        html,
        {
          cheerio: cheerio.default,
        },
      );
    }

    if (options.runAllCodeChunks) {
      await runCodeChunks(this.codeChunksData, this.generateRunOptions());
      options.runAllCodeChunks = false;
      return this.parseMD(inputString, options);
    }

    if (options.isForPreview) {
      // this.cachedHTML = html // save to cache
      this.isPreviewInPresentationMode = !!slideConfigs.length; // check presentation mode
    }

    if (options.triggeredBySave && yamlConfig['export_on_save']) {
      // export files
      this.exportOnSave(yamlConfig['export_on_save'] as JsonObject);
    }

    if (!this.notebook.config.enableScriptExecution) {
      // disable importing js and css files.
      JSAndCssFiles = [];
    }

    return {
      html,
      markdown: inputString,
      tocHTML: this.tocHTML,
      yamlConfig,
      JSAndCssFiles,
    };
  }

  /**
   * legacy method to support backwards compatibility
   */
  public runCodeChunks() {
    return runCodeChunks(this.codeChunksData, this.generateRunOptions());
  }

  /**
   * legacy method to support backwards compatibility
   */
  public runCodeChunk(id: string) {
    return runCodeChunk(id, this.codeChunksData, this.generateRunOptions());
  }

  private generateRunOptions(): RunCodeChunkOptions {
    return {
      enableScriptExecution: this.notebook.config.enableScriptExecution,
      fileDirectoryPath: this.fileDirectoryPath,
      filePath: this.filePath,
      imageFolderPath: this.notebook.config.imageFolderPath,
      latexEngine: this.notebook.config.latexEngine,
      modifySource: MarkdownEngine.modifySource.bind(this),
      parseMD: this.parseMD.bind(this),
      headings: this.headings,
    };
  }
}
