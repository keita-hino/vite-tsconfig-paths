import { dirname, posix, isAbsolute } from 'path'
import { normalizePath, Plugin } from 'vite'
import { createMatchPathAsync, loadConfig } from 'tsconfig-paths'
import { loadTsconfig } from 'tsconfig-paths/lib/tsconfig-loader'
import { crawl } from 'recrawl-sync'
import globRex = require('globrex')

const { join, resolve } = posix

const debug = require('debug')('vite-tsconfig-paths')

type PluginOptions = {
  /**
   * The directory to crawl for `tsconfig.json` files.
   *
   * @default viteConfig.root
   */
  root?: string
  /**
   * An array of `tsconfig.json` paths (relative to `viteConfig.root`)
   * and/or directories that contain a `tsconfig.json` file.
   *
   * When undefined, we crawl the project for `tsconfig.json` files.
   * You can set the `root` option to control where crawling starts.
   */
  projects?: string[]
  /**
   * Implicit extensions used when resolving an import path
   * like `./App` which has no explicit extension like `./App.vue` does.
   *
   * TypeScript and JavaScript extensions are used by default.
   */
  extensions?: string[]
  /**
   * Disable strictness that limits path resolution to TypeScript
   * and JavaScript modules.
   *
   * Useful if you want asset URLs in Vue templates to be resolved,
   * or when `"allowJs": true` in your tsconfig isn't good enough.
   */
  loose?: boolean
}

export default (opts: PluginOptions = {}): Plugin => ({
  name: 'vite:tsconfig-paths',
  enforce: 'pre',
  configResolved({ root: viteRoot }) {
    const projects = findProjects(viteRoot, opts)
    const extensions = getFileExtensions(opts.extensions)
    debug('options:', { projects, extensions })

    let viteResolve: Resolver
    this.buildStart = function () {
      viteResolve = async (id, importer) =>
        (await this.resolve(id, importer, { skipSelf: true }))?.id
    }

    const resolvers = projects.map(createResolver).filter(Boolean) as Resolver[]
    this.resolveId = async function (id, importer) {
      if (importer && !relativeImportRE.test(id) && !isAbsolute(id)) {
        for (const resolve of resolvers) {
          const resolved = await resolve(id, importer)
          if (resolved) {
            return resolved
          }
        }
      }
    }

    type Resolver = (
      id: string,
      importer: string
    ) => Promise<string | undefined>

    function createResolver(root: string): Resolver | null {
      const configPath = root.endsWith('.json') ? root : null
      if (configPath) root = dirname(root)
      root += '/'

      const config = loadConfig(configPath || root)
      debug('loadConfig:', { configPath, ...config })
      if (config.resultType == 'failed') {
        return null
      }

      // Even if "paths" is undefined, the "baseUrl" is still
      // used to resolve bare imports.
      let resolveId: Resolver = (id, importer) =>
        viteResolve(join(config.absoluteBaseUrl, id), importer)

      if (config.paths) {
        const matchPath = createMatchPathAsync(
          config.absoluteBaseUrl,
          config.paths,
          config.mainFields || [
            'module',
            'jsnext',
            'jsnext:main',
            'browser',
            'main',
          ],
          config.addMatchAll
        )

        const resolveWithBaseUrl = resolveId
        const resolveWithPaths: Resolver = (id, importer) =>
          new Promise((done) => {
            matchPath(id, void 0, void 0, extensions, (error, path) => {
              if (path) {
                path = normalizePath(path)
                done(viteResolve(path, importer))
              } else {
                error && debug(error.message)
                done(void 0)
              }
            })
          })

        resolveId = (id, importer) =>
          resolveWithPaths(id, importer).then(
            (resolved) => resolved || resolveWithBaseUrl(id, importer)
          )
      }

      const compilerOptions = loadCompilerOptions(config.configFileAbsolutePath)
      const isIncluded = getIncluder(compilerOptions)

      let importerExtRE = /./
      if (!opts.loose) {
        importerExtRE = compilerOptions.allowJs
          ? /\.(vue|svelte|mdx|mjs|[jt]sx?)$/
          : /\.tsx?$/
      }

      const resolved = new Map<string, string>()
      return async (id, importer) => {
        if (importerExtRE.test(importer)) {
          let path = resolved.get(id)
          if (!path && isLocalDescendant(importer, root)) {
            if (!isIncluded(importer.slice(root.length))) return
            path = await resolveId(id, importer)
            if (path) {
              resolved.set(id, path)
              debug(`resolved:`, {
                id,
                importer,
                resolvedId: path,
                configPath: config.configFileAbsolutePath,
                compilerOptions,
              })
            }
          }
          return path
        }
      }
    }
  },
})

const nodeModulesRE = /\/node_modules\//
const relativeImportRE = /^\.\.?(\/|$)/

/** Returns true when `path` is within `root` and not an installed dependency. */
function isLocalDescendant(path: string, root: string) {
  return path.startsWith(root) && !nodeModulesRE.test(path.slice(root.length))
}

interface CompilerOptions {
  include?: string[]
  exclude?: string[]
  allowJs?: boolean
}

function loadCompilerOptions(configPath: string): CompilerOptions {
  const {
    include,
    exclude,
    compilerOptions: { allowJs, checkJs },
  }: any = loadTsconfig(configPath)
  return {
    include,
    exclude,
    allowJs: allowJs || checkJs,
  }
}

function compileGlob(glob: string) {
  return globRex(glob + (glob.endsWith('*') ? '' : '**/*'), {
    extended: true,
  }).regex
}

function getIncluder({ include = [], exclude = [] }: CompilerOptions) {
  if (include.length || exclude.length) {
    const included = include.map(compileGlob)
    const excluded = exclude.map(compileGlob)
    return (path: string) =>
      (!included.length || included.some((glob) => glob.test(path))) &&
      (!excluded.length || !excluded.some((glob) => glob.test(path)))
  }
  return () => true
}

function findProjects(viteRoot: string, opts: PluginOptions) {
  const root = opts.root
    ? normalizePath(resolve(viteRoot, opts.root))
    : viteRoot

  let { projects } = opts
  if (!projects) {
    projects = crawl(root || viteRoot, {
      only: ['tsconfig.json'],
      skip: ['node_modules', '.git'],
    })
  }

  // Calculate the depth of each project path.
  const depthMap: { [path: string]: number } = {}
  projects = projects.map((projectPath) => {
    projectPath = resolve(root, normalizePath(projectPath))
    depthMap[projectPath] =
      projectPath.split('/').length - (projectPath.endsWith('.json') ? 1 : 0)
    return projectPath
  })

  // Ensure deeper projects take precedence.
  return projects.sort((a, b) => depthMap[b] - depthMap[a])
}

function getFileExtensions(exts?: string[]) {
  const requiredExts = ['.ts', '.tsx', '.js', '.jsx', '.mjs']
  return exts ? exts.concat(requiredExts) : requiredExts
}
