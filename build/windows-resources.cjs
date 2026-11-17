const { readFile, writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const { Data, NtExecutable, NtExecutableResource, Resource } = require('resedit')

module.exports = async ({ electronPlatformName, appOutDir, packager }) => {
  if (electronPlatformName !== 'win32') return

  const { productFilename, productName, version } = packager.appInfo
  const fileName = `${productFilename}.exe`
  const executablePath = join(appOutDir, fileName)
  const [binary, icon] = await Promise.all([
    readFile(executablePath),
    readFile(join(__dirname, 'icon.ico'))
  ])
  const executable = NtExecutable.from(binary)
  const resource = NtExecutableResource.from(executable)
  const { entries } = resource
  const groups = Resource.IconGroupEntry.fromEntries(entries)
  if (groups.length === 0) throw new Error(`Missing Windows icon group in ${fileName}`)
  const images = Data.IconFile.from(icon).icons.map(item => item.data)
  for (const { id, lang } of groups) {
    Resource.IconGroupEntry.replaceIconsForResource(entries, id, lang, images)
  }

  for (const info of Resource.VersionInfo.fromEntries(entries)) {
    info.setFileVersion(version)
    info.setProductVersion(version)
    for (const language of info.getAllLanguagesForStringValues()) {
      info.setStringValues(language, {
        FileDescription: productName,
        ProductName: productName,
        InternalName: productFilename,
        OriginalFilename: fileName
      })
    }
    info.outputToResourceEntries(entries)
  }

  resource.outputResource(executable)
  await writeFile(executablePath, Buffer.from(executable.generate()))
}
