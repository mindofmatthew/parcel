const {relative} = require('path');
const babylon = require('babylon');
const template = require('babel-template');
const t = require('babel-types');
const traverse = require('babel-traverse').default;
const generate = require('babel-generator').default;
const treeShake = require('../scope-hoisting/shake');
const mangleScope = require('../scope-hoisting/mangler');

const EXPORTS_RE = /^\$([\d]+)\$exports$/;
const EXPORT_RE = /^\$([\d]+)\$export\$(.+)$/;

const DEFAULT_INTEROP_TEMPLATE = template('var NAME = $parcel$interopDefault(MODULE)');
const THROW_TEMPLATE = template('$parcel$missingModule(MODULE)');

module.exports = packager => {
  let {contents: code, exports, addedAssets} = packager;
  let replacements = new Map;
  let ast = babylon.parse(code, {
    allowReturnOutsideFunction: true
  });
  // Share $parcel$interopDefault variables between modules
  let interops = new Map();
  let imports = new Map;

  let assets = Array.from(addedAssets).reduce((acc, asset) => {
    acc[asset.id] = asset;

    return acc;
  }, {});

  // Build a mapping of all imported identifiers to replace.
  for (let asset of addedAssets) {
    for (let name in asset.cacheData.imports) {
      let imp = asset.cacheData.imports[name];
      imports.set(name, [resolveModule(asset.id, imp[0]), imp[1]]);
    }
  }

  function resolveModule(id, name) {
    let module = assets[id];
    return module.depAssets.get(module.dependencies.get(name));
  }

  function findExportModule(id, name) {
    let module = assets[id];
    let exp = module && module.cacheData.exports[name];

    // If this is a re-export, find the original module.
    if (Array.isArray(exp)) {
      let mod = resolveModule(id, exp[0]);
      return findExportModule(mod.id, exp[1]);
    }

    // If this module exports wildcards, resolve the original module.
    // Default exports are excluded from wildcard exports.
    let wildcards = module && module.cacheData.wildcards;
    if (wildcards && name !== 'default') {
      for (let source of wildcards) {
        let m = findExportModule(resolveModule(id, source).id, name);
        if (m) {
          return m;
        }
      }
    }

    // If this is a wildcard import, resolve to the exports object.
    if (module && name === '*') {
      exp = `$${id}$exports`;
    }

    if (replacements.has(exp)) {
      exp = replacements.get(exp);
    }

    return exp;
  }

  function replaceExportNode(mod, originalName, path) {
    let id = mod.id;
    let res = findExportModule(id, originalName);
    let node;

    if (res) {
      node = find(id, res);
    }

    // If the module is not in this bundle, create a `require` call for it.
    if (!node && !assets[id]) {
      node = t.callExpression(t.identifier('require'), [t.numericLiteral(id)]);
      return t.memberExpression(node, t.identifier(originalName));
    }

    // If this is an ES6 module, throw an error if we cannot resolve the module
    if (!node && !mod.cacheData.isCommonJS) {
      let relativePath = relative(packager.options.rootDir, mod.name);
      throw new Error(`${relativePath} does not export '${originalName}'`);
    }

    // If it is CommonJS, look for an exports object.
    if (!node && mod.cacheData.isCommonJS) {
      node = find(id, `$${id}$exports`);
      if (!node) {
        return null;
      }

      // Handle interop for default imports of CommonJS modules.
      if (mod.cacheData.isCommonJS && originalName === 'default') {
        let name = `$${id}$interop$default`;
        if (!interops.has(node.name)) {
          let [decl] = path.getStatementParent().insertBefore(DEFAULT_INTEROP_TEMPLATE({
            NAME: t.identifier(name),
            MODULE: node
          }));

          path.scope.getBinding(node.name).reference(decl.get('declarations.0.init'));
          path.scope.registerDeclaration(decl);

          interops.set(name, node.name);
        }

        return t.memberExpression(t.identifier(name), t.identifier('d'));
      }

      // if there is a CommonJS export return $id$exports.name
      return t.memberExpression(node, t.identifier(originalName));
    }

    return node;

    function find(id, symbol) {
      if (replacements.has(symbol)) {
        symbol = replacements.get(symbol);
      }

      // if the symbol is in the scope there is not need to remap it
      if (path.scope.getProgramParent().hasBinding(symbol)) {
        return t.identifier(symbol);
      }

      return null;
    }
  }

  console.time('concat');

  traverse(ast, {
    CallExpression(path) {
      let {arguments: args, callee} = path.node;

      if (!t.isIdentifier(callee)) {
        return;
      }

      // each require('module') call gets replaced with $parcel$require(id, 'module')
      if (callee.name === '$parcel$require') {
        let [id, source] = args;

        if (
          args.length !== 2 ||
          !t.isNumericLiteral(id) ||
          !t.isStringLiteral(source)
        ) {
          throw new Error(
            'invariant: invalid signature, expected : $parcel$require(number, string)'
          );
        }

        let mod = resolveModule(id.value, source.value);

        if (!mod) {
          if (assets[id.value].dependencies.get(source.value).optional) {
            path.replaceWith(
              THROW_TEMPLATE({MODULE: t.stringLiteral(source.value)})
            );
          } else {
            throw new Error(
              `Cannot find module "${source.value}" in asset ${id.value}`
            );
          }
        } else {
          let name = `$${mod.id}$exports`;
          let id = t.identifier(replacements.get(name) || name);
          path.replaceWith(id);
        }
      } else if (callee.name === '$parcel$require$resolve') {
        let [id, source] = args;

        if (
          args.length !== 2 ||
          !t.isNumericLiteral(id) ||
          !t.isStringLiteral(source)
        ) {
          throw new Error(
            'invariant: invalid signature, expected : $parcel$require$resolve(number, string)'
          );
        }

        let mapped = assets[id.value];
        let dep = mapped.dependencies.get(source.value);
        let mod = mapped.depAssets.get(dep);
        let bundles = mod.id;

        if (dep.dynamic && packager.bundle.childBundles.has(mod.parentBundle)) {
          bundles = [packager.getBundleSpecifier(mod.parentBundle)];

          for (let child of mod.parentBundle.siblingBundles) {
            if (!child.isEmpty) {
              bundles.push(packager.getBundleSpecifier(child));
            }
          }

          bundles.push(mod.id);
        }

        path.replaceWith(t.valueToNode(bundles));
      }
    },
    VariableDeclarator: {
      exit(path) {
        // Replace references to declarations like `var x = require('x')`
        // with the final export identifier instead.
        // This allows us to potentially replace accesses to e.g. `x.foo` with
        // a variable like `$id$export$foo` later, avoiding the exports object altogether.
        let {id, init} = path.node;
        if (!t.isIdentifier(init)) {
          return;
        }

        let match = init.name.match(EXPORTS_RE);
        if (!match) {
          return;
        }

        // Replace patterns like `var {x} = require('y')` with e.g. `$id$export$x`.
        if (t.isObjectPattern(id)) {
          for (let p of path.get('id.properties')) {
            let {computed, key, value} = p.node;
            if (computed || !t.isIdentifier(key) || !t.isIdentifier(value)) {
              continue;
            }

            let exp = findExportModule(match[1], key.name, path);
            if (exp) {
              replace(value.name, exp, p);
            }
          }

          if (id.properties.length === 0) {
            path.remove();
          }
        } else if (t.isIdentifier(id)) {
          replace(id.name, init.name, path);
        }

        function replace(id, init, path) {
          let binding = path.scope.getBinding(id);
          if (!binding.constant) {
            return;
          }

          for (let ref of binding.referencePaths) {
            ref.replaceWith(t.identifier(init));
          }

          replacements.set(id, init);
          path.remove();
        }
      }
    },
    MemberExpression: {
      exit(path) {
        if (!path.isReferenced()) {
          return;
        }

        let {object, property} = path.node;
        if (!t.isIdentifier(object) || !t.isIdentifier(property)) {
          return;
        }

        let match = object.name.match(EXPORTS_RE);

        // If it's a $id$exports.name expression.
        if (match) {
          let exp = findExportModule(match[1], property.name, path);

          // Check if $id$export$name exists and if so, replace the node by it.
          if (exp) {
            path.replaceWith(t.identifier(exp));
          }
        }
      }
    },
    ReferencedIdentifier(path) {
      let {name} = path.node;

      if (typeof name !== 'string') {
        return;
      }

      if (imports.has(name)) {
        let imp = imports.get(name);
        let node = replaceExportNode(imp[0], imp[1], path);
        path.replaceWith(node);
        return;
      }

      let match = name.match(EXPORTS_RE);

      // If it's an undefined $id$exports identifier.
      if (match && !path.scope.hasBinding(name)) {
        let id = Number(match[1]);

        // If the id is in the bundle it may just be empty, replace with {}.
        if (id in assets) {
          path.replaceWith(t.objectExpression([]));
        }
      }
    },
    Program: {
      // A small optimization to remove unused CommonJS exports as sometimes Uglify doesn't remove them.
      exit(path) {
        treeShake(path.scope);

        if (packager.options.minify) {
          mangleScope(path.scope);
        }
      }
    }
  });

  console.timeEnd('concat');

  let opts = {
    sourceMaps: packager.options.sourceMaps,
    sourceFileName: packager.bundle.name,
    minified: packager.options.minify,
    comments: !packager.options.minify
  };

  console.time('generate');
  let res = generate(ast, opts, code);
  console.timeEnd('generate');
  console.log('\n\n');
  return res;
};