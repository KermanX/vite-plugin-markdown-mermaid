import Frontmatter from "front-matter";
import MarkdownIt from "markdown-it";
import type { Plugin } from "vite";
import { DomUtils, parseDocument } from "htmlparser2";
import { Element, Node as DomHandlerNode } from "domhandler";
import { NodeMermaidRender } from "node-mermaid-render";

export enum Mode {
  TOC = "toc",
  HTML = "html",
  REACT = "react",
  VUE = "vue",
  MARKDOWN = "markdown",
}

export interface PluginOptions {
  mode?: Mode[];
  markdown?: (body: string) => string;
  markdownIt?: MarkdownIt | MarkdownIt.Options;
}

type MermaidCodeStorage = string[];

const mermaidChart = (code: string, storage: MermaidCodeStorage) => {
  try {
  } catch (e: any) {
    if ("str" in e) return `<pre>MERMAID ERROR: ${e["str"]}</pre>`; // Mermaid error
    else if(e instanceof Error) return `<pre>${e} at ${e.stack}</pre>`;
    else return `<pre>${e}</pre>`;
  }
  const index = storage.length;
  storage.push(code);
  return `<div class="vite-plugin-markdown-mermaid-code">${index}</div>`;
};

function addMermaidPlugin(md: MarkdownIt, storage: MermaidCodeStorage) {
  const original = md.renderer.rules.fence!.bind(md.renderer.rules);
  md.renderer.rules.fence = (tokens, idx, options, env, slf) => {
    const token = tokens[idx];
    const code = token.content.trim();
    if (token.info === "mermaid") {
      return mermaidChart(code, storage);
    }
    return original(tokens, idx, options, env, slf);
  };
  return md;
}

const markdownCompiler = (
  options: PluginOptions,
  storage: MermaidCodeStorage
): MarkdownIt | { render: (body: string) => string } => {
  if (options.markdownIt) {
    if (
      options.markdownIt instanceof MarkdownIt ||
      options.markdownIt?.constructor?.name === "MarkdownIt"
    ) {
      return addMermaidPlugin(options.markdownIt as MarkdownIt, storage);
    } else if (typeof options.markdownIt === "object") {
      return addMermaidPlugin(MarkdownIt(options.markdownIt), storage);
    } else {
      throw new Error(
        "options.markdownIt should be MarkdownIt instance or MarkdownIt options"
      );
    }
  }
  if (options.markdown) {
    return { render: options.markdown };
  }
  return addMermaidPlugin(
    MarkdownIt({
      html: true,
      xhtmlOut: options.mode?.includes(Mode.REACT),
    }),
    storage
  ); // TODO: xhtmlOut should be got rid of in next major update
};

class ExportedContent {
  #exports: string[] = [];
  #contextCode = "";

  addContext(contextCode: string): void {
    this.#contextCode += `${contextCode}\n`;
  }

  addExporting(exported: string): void {
    this.#exports.push(exported);
  }

  export(): string {
    return [this.#contextCode, `export { ${this.#exports.join(", ")} }`].join(
      "\n"
    );
  }
}

const tf = async (code: string, id: string, options: PluginOptions) => {
  if (!id.endsWith(".md")) return null;

  const content = new ExportedContent();
  const fm = Frontmatter<unknown>(code);
  content.addContext(`const attributes = ${JSON.stringify(fm.attributes)}`);
  content.addExporting("attributes");

  const storage: MermaidCodeStorage = [];

  const rawHtml = markdownCompiler(options, storage).render(fm.body);
  const root = parseDocument(rawHtml);
  const compiledMermaidIndex = new Array(storage.length).fill(false);

  const mermaidRender = new NodeMermaidRender();

  const renderMermaid = async (node: DomHandlerNode) => {
    if (node instanceof Element) {
      if (
        node.tagName === "div" &&
        node.attribs.class === "vite-plugin-markdown-mermaid-code"
      ) {
        const index = +DomUtils.getInnerHTML(node);

        if (!Number.isFinite(index)) {
          throw new Error("Mermaid code index is not a number: " + index);
        }

        const definition = storage[index];
        compiledMermaidIndex[index] = true;

        const svg = await mermaidRender.renderToSVG(definition);
        DomUtils.replaceElement(
          node.firstChild!,
          parseDocument(svg.data.toString()).firstChild!
        );
      } else {
        node.childNodes.forEach(renderMermaid);
      }
    }
  };
  for (const node of root.childNodes) {
    await renderMermaid(node);
  }

  await mermaidRender.close();

  compiledMermaidIndex.forEach((compiled, index) => {
    if (!compiled) {
      throw new Error(
        `Mermaid code at index ${index} is not compiled. Please check your code.`
      );
    }
  });

  if (options.mode?.includes(Mode.HTML)) {
    const html = DomUtils.getOuterHTML(root);

    content.addContext(`const html = ${JSON.stringify(html)}`);
    content.addExporting("html");
  }

  if (options.mode?.includes(Mode.MARKDOWN)) {
    content.addContext(`const markdown = ${JSON.stringify(fm.body)}`);
    content.addExporting("markdown");
  }

  if (options.mode?.includes(Mode.TOC)) {
    const indicies = root.childNodes.filter(
      (rootSibling) =>
        rootSibling instanceof Element &&
        ["h1", "h2", "h3", "h4", "h5", "h6"].includes(rootSibling.tagName)
    ) as Element[];

    const toc: { level: string; content: string }[] = indicies.map((index) => ({
      level: index.tagName.replace("h", ""),
      content: DomUtils.getInnerHTML(index),
    }));

    content.addContext(`const toc = ${JSON.stringify(toc)}`);
    content.addExporting("toc");
  }

  if (options.mode?.includes(Mode.REACT)) {
    const subComponentNamespace = "SubReactComponent";

    const markCodeAsPre = (node: DomHandlerNode): void => {
      if (node instanceof Element) {
        if (node.tagName.match(/^[A-Z].+/)) {
          node.tagName = `${subComponentNamespace}.${node.tagName}`;
        }
        if (["pre", "code"].includes(node.tagName) && node.attribs?.class) {
          node.attribs.className = node.attribs.class;
          delete node.attribs.class;
        }

        if (node.tagName === "code") {
          const codeContent = DomUtils.getInnerHTML(node, {
            decodeEntities: true,
          });
          node.attribs.dangerouslySetInnerHTML = `vfm{{ __html: \`${codeContent.replace(
            /([\\`])/g,
            "\\$1"
          )}\`}}vfm`;
          node.childNodes = [];
        }

        if (node.childNodes.length > 0) {
          node.childNodes.forEach(markCodeAsPre);
        }
      }
    };
    root.childNodes.forEach(markCodeAsPre);

    const h = DomUtils.getOuterHTML(root, { selfClosingTags: true })
      .replace(/"vfm{{/g, "{{")
      .replace(/}}vfm"/g, "}}");

    const reactCode = `
      const markdown =
        <div>
          ${h}
        </div>
    `;
    const compiledReactCode = `
      function (props) {
        Object.keys(props).forEach(function (key) {
          SubReactComponent[key] = props[key]
        })
        ${
          require("@babel/core").transformSync(reactCode, {
            ast: false,
            presets: ["@babel/preset-react"],
          }).code
        }
        return markdown
      }
    `;
    content.addContext(
      `import React from "react"\nconst ${subComponentNamespace} = {}\nconst ReactComponent = ${compiledReactCode}`
    );
    content.addExporting("ReactComponent");
  }

  if (options.mode?.includes(Mode.VUE)) {
    // Top-level <pre> tags become <pre v-pre>
    root.childNodes.forEach((node: DomHandlerNode) => {
      if (node instanceof Element) {
        if (["pre", "code"].includes(node.tagName)) {
          node.attribs["v-pre"] = "true";
        }
      }
    });

    // Any <code> tag becomes <code v-pre> excepting under `<pre>`
    const markCodeAsPre = (node: DomHandlerNode): void => {
      if (node instanceof Element) {
        if (node.tagName === "code") node.attribs["v-pre"] = "true";
        if (node.childNodes.length > 0) node.childNodes.forEach(markCodeAsPre);
      }
    };
    root.childNodes.forEach(markCodeAsPre);

    const { code: compiledVueCode } =
      require("@vue/compiler-sfc").compileTemplate({
        source: DomUtils.getOuterHTML(root, { decodeEntities: true }),
        filename: id,
        id,
      });
    content.addContext(
      compiledVueCode.replace(
        "\nexport function render(",
        "\nfunction vueRender("
      ) +
        `\nconst VueComponent = { render: vueRender }\nVueComponent.__hmrId = ${JSON.stringify(
          id
        )}\nconst VueComponentWith = (components) => ({ components, render: vueRender })\n`
    );
    content.addExporting("VueComponent");
    content.addExporting("VueComponentWith");
  }

  return {
    code: content.export(),
  };
};

export const plugin = (options: PluginOptions = {}): Plugin => {
  return {
    name: "vite-plugin-markdown",
    enforce: "pre",
    transform(code, id) {
      return tf(code, id, options);
    },
  };
};

export default plugin;
