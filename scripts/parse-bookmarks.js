#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

function usage() {
  console.error(`Usage: node parse-bookmarks.js [options] [input.html]

Options:
  --input <path>   Netscape bookmarks export (default: ../../bookmarks.html)
  --folder <name>  Import one folder as a single section (default: each top-level folder)
  --out <path>     Output links.json path (default: ../data/links.json)
  -h, --help       Show this help
`);
}

function parseArgs(argv) {
  const args = {
    input: path.join(__dirname, "..", "..", "bookmarks.html"),
    folder: null,
    out: path.join(__dirname, "..", "data", "links.json"),
    help: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else if (arg === "--input") {
      args.input = argv[++i];
    } else if (arg === "--folder") {
      args.folder = argv[++i];
    } else if (arg === "--out") {
      args.out = argv[++i];
    } else if (!arg.startsWith("-")) {
      args.input = arg;
    } else {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }
  }

  return args;
}

function decodeHref(href) {
  return href
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/%22/g, '"');
}

function extractDlInner(content, startIdx) {
  const open = content.indexOf("<DL><p>", startIdx);
  if (open === -1) {
    return null;
  }
  let depth = 1;
  let i = open + "<DL><p>".length;
  while (i < content.length && depth > 0) {
    const nextOpen = content.indexOf("<DL><p>", i);
    const nextClose = content.indexOf("</DL><p>", i);
    if (nextClose === -1) {
      return null;
    }
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      i = nextOpen + "<DL><p>".length;
    } else {
      depth -= 1;
      if (depth === 0) {
        return {
          inner: content.slice(open + "<DL><p>".length, nextClose),
          end: nextClose + "</DL><p>".length,
        };
      }
      i = nextClose + "</DL><p>".length;
    }
  }
  return null;
}

function parseFolderBlock(block) {
  const links = [];
  const folders = [];
  let i = 0;

  while (i < block.length) {
    const dtIdx = block.indexOf("<DT>", i);
    if (dtIdx === -1) {
      break;
    }

    const h3Match = block.slice(dtIdx).match(/^<DT><H3[^>]*>([^<]+)<\/H3>/i);
    if (h3Match) {
      const folderName = h3Match[1].trim();
      const dl = extractDlInner(block, dtIdx + h3Match[0].length);
      if (!dl) {
        break;
      }
      folders.push({
        name: folderName,
        ...parseFolderBlock(dl.inner),
      });
      i = dl.end;
      continue;
    }

    const linkMatch = block
      .slice(dtIdx)
      .match(/^<DT><A HREF="([^"]*)"[^>]*>([^<]*)<\/A>/i);
    if (linkMatch) {
      links.push({
        title: linkMatch[2].trim(),
        href: decodeHref(linkMatch[1]),
      });
      i = dtIdx + linkMatch[0].length;
      continue;
    }

    i = dtIdx + 4;
  }

  return { links, folders };
}

function findFolderByName(html, folderName) {
  const pattern = new RegExp(
    `<DT><H3[^>]*>${folderName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}<\\/H3>`,
    "i"
  );
  const match = html.match(pattern);
  if (!match) {
    return null;
  }
  const dl = extractDlInner(html, match.index);
  if (!dl) {
    return null;
  }
  return {
    name: folderName,
    ...parseFolderBlock(dl.inner),
  };
}

function findBookmarkRoot(html) {
  const idx = html.indexOf("<DL><p>");
  if (idx === -1) {
    return null;
  }
  const dl = extractDlInner(html, idx);
  if (!dl) {
    return null;
  }
  return parseFolderBlock(dl.inner);
}

function collectAbsoluteHostnames(node) {
  const hostnames = [];
  for (const link of node.links) {
    if (/^https?:\/\//i.test(link.href)) {
      try {
        hostnames.push(new URL(link.href).hostname);
      } catch {
        // skip malformed URLs
      }
    }
  }
  for (const folder of node.folders) {
    hostnames.push(...collectAbsoluteHostnames(folder));
  }
  return hostnames;
}

function longestCommonHostSuffix(hostnames) {
  if (hostnames.length === 0) {
    return null;
  }
  const reversed = hostnames.map((hostname) => hostname.split(".").reverse());
  const minLen = Math.min(...reversed.map((parts) => parts.length));
  const common = [];
  for (let i = 0; i < minLen; i += 1) {
    const label = reversed[0][i];
    if (reversed.every((parts) => parts[i] === label)) {
      common.push(label);
    } else {
      break;
    }
  }
  return common.length > 0 ? common.reverse().join(".") : null;
}

function inferHostPattern(hostnames) {
  const unique = [...new Set(hostnames.filter(Boolean))];
  if (unique.length === 0) {
    return null;
  }
  if (unique.length === 1) {
    const hostname = unique[0];
    return `^${hostname.replace(/\./g, "\\.")}$`;
  }

  const suffix = longestCommonHostSuffix(unique);
  if (
    suffix &&
    unique.every(
      (hostname) => hostname === suffix || hostname.endsWith(`.${suffix}`)
    )
  ) {
    return `\\.${suffix.replace(/\./g, "\\.")}$`;
  }

  return null;
}

function matchesHostPattern(urlString, pattern) {
  if (!pattern) {
    return false;
  }
  try {
    const url = new URL(urlString);
    const re = new RegExp(pattern, "i");
    return re.test(url.hostname) || re.test(url.href);
  } catch {
    return false;
  }
}

function hrefToLinkFields(href, sectionHostPattern) {
  if (href.startsWith("javascript:")) {
    let code = href.slice("javascript:".length);
    if (code.startsWith("void(") && code.endsWith(")")) {
      code = code.slice(5, -1);
    }
    return { code: code.trim() };
  }

  if (/^https?:\/\//i.test(href)) {
    const url = new URL(href);
    const absolute = url.href;
    if (sectionHostPattern && matchesHostPattern(absolute, sectionHostPattern)) {
      return {
        url: `${url.pathname}${url.search}${url.hash}`,
        open: "tab",
      };
    }
    return {
      url: absolute,
      open: "tab",
      match: null,
    };
  }

  return {
    url: href.startsWith("/") ? href : `/${href}`,
    open: "tab",
  };
}

function folderNodeToChildren(node, sectionHostPattern) {
  const children = [];

  for (const folder of node.folders) {
    children.push({
      name: folder.name,
      children: folderNodeToChildren(folder, sectionHostPattern),
    });
  }

  for (const link of node.links) {
    const fields = hrefToLinkFields(link.href, sectionHostPattern);
    children.push({
      id: crypto.randomUUID(),
      name: link.title,
      ...fields,
    });
  }

  return children;
}

function sectionFromFolderNode(node) {
  const match = inferHostPattern(collectAbsoluteHostnames(node));
  return {
    match,
    children: folderNodeToChildren(node, match),
  };
}

function buildCatalog(rootNode, folderFilter) {
  if (folderFilter) {
    const folder = findFolderByName(
      typeof rootNode === "string" ? rootNode : "",
      folderFilter
    );
    if (!folder) {
      throw new Error(`Folder not found: ${folderFilter}`);
    }
    return { [folder.name]: sectionFromFolderNode(folder) };
  }

  const parsed =
    typeof rootNode === "string" ? findBookmarkRoot(rootNode) : rootNode;
  if (!parsed) {
    throw new Error("Bookmark root not found.");
  }

  const catalog = {};
  for (const folder of parsed.folders) {
    catalog[folder.name] = sectionFromFolderNode(folder);
  }

  if (parsed.links.length > 0) {
    catalog.Imported = sectionFromFolderNode({
      name: "Imported",
      links: parsed.links,
      folders: [],
    });
  }

  return catalog;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    process.exit(0);
  }

  if (!fs.existsSync(args.input)) {
    console.error(`Input not found: ${args.input}`);
    process.exit(1);
  }

  const html = fs.readFileSync(args.input, "utf8");
  let catalog;

  try {
    catalog = args.folder
      ? buildCatalog(html, args.folder)
      : buildCatalog(html, null);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const sectionCount = Object.keys(catalog).length;
  const linkCount = Object.values(catalog).reduce((total, section) => {
    function countNodes(nodes) {
      let count = 0;
      for (const node of nodes) {
        if (node.children) {
          count += countNodes(node.children);
        } else {
          count += 1;
        }
      }
      return count;
    }
    return total + countNodes(section.children || []);
  }, 0);

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(catalog, null, 2));
  console.log(
    `Wrote ${linkCount} link(s) in ${sectionCount} section(s) to ${args.out}`
  );
}

main();
