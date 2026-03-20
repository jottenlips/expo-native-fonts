import { ConfigPlugin, ExportedConfigWithProps, XcodeProject, withXcodeProject, IOSConfig } from "@expo/config-plugins"
import { ExpoNativeFontOptions, ExpoNativeFontsOptions } from ".."
import * as path from "path"
import fsExtra from "fs-extra"

const getIOSFonts = (options: ExpoNativeFontsOptions) => {
    return options.fonts.filter(f => f.platform !== 'android')
}

type FontsGrouped = {
    [targetId: string]: ExpoNativeFontOptions[]
}

const groupByTarget = (fonts: ExpoNativeFontOptions[]) => {
    let groupedFonts: FontsGrouped = {}

    for (const font of fonts) {
        const {
            targets,
        } = font

        if (!targets) {
            throw new Error(`Targets is required for iOS font ${font.name || font.filePath}`)
        }

        for (const target of targets) {
            groupedFonts[target] = [
                ...(groupedFonts[target] || []),
                font,
            ]
        }
    }

    return groupedFonts
}

const updateXcodeProject = (config: ExportedConfigWithProps<XcodeProject>, options: ExpoNativeFontsOptions, grouped: FontsGrouped) => {
    const targets = Object.keys(grouped)

    copyFontFiles(config, options)

    for (const target of targets) {
        const fonts = grouped[target]
        copyFontFilesToTarget(config, options, target, fonts)
        addFontToXcodeProj(config, options, target, fonts)
    }

    return config
}

const getFontName = ({ name, filePath }: ExpoNativeFontOptions) => {
    if (name) {
        return name
    }

    const ext = path.extname(filePath)
    return path.basename(filePath).replace(ext, "")
}

const getPBXTargetByName = (project: XcodeProject, name: string) => {
    var targetSection = project.pbxNativeTargetSection()

    for (const uuid in targetSection) {
        const target = targetSection[uuid]

        if (target.name === name) {
            return {
                uuid,
                target,
            }
        }
    }

    return { target: null, uuid: null }
}

/**
 * Find the PBXResourcesBuildPhase for a specific target, regardless of its comment name.
 * This is needed because extension targets (e.g. widgets) may have their resources build phase
 * created with a non-standard comment (e.g. "Embed Foundation Extensions" instead of "Resources"),
 * which causes the xcode library's addToPbxResourcesBuildPhase to fall back to the main app target.
 */
const getResourcesBuildPhaseForTarget = (project: XcodeProject, targetUuid: string) => {
    const target = project.pbxNativeTargetSection()[targetUuid]
    if (!target || !target.buildPhases) {
        return null
    }

    const pbxResourcesBuildPhaseSection = project.hash.project.objects['PBXResourcesBuildPhase']

    for (const phase of target.buildPhases) {
        const phaseUuid = phase.value
        if (pbxResourcesBuildPhaseSection[phaseUuid]) {
            return pbxResourcesBuildPhaseSection[phaseUuid]
        }
    }

    return null
}

const addFontToXcodeProj = (config: ExportedConfigWithProps<XcodeProject>, options: ExpoNativeFontsOptions, targetName: string, fonts: ExpoNativeFontOptions[]) => {
    console.log(`Adding fonts to target ${targetName}`)
    const project = config.modResults;

    const fontFiles = fonts.map(font => font.filePath)
    console.log('Font files:')
    console.log(fontFiles)

    console.log(`Searching for target ${targetName}`)
    const { target, uuid: targetUuid } = getPBXTargetByName(project, targetName)

    if (!target || !targetUuid) {
        throw new Error(`expo-native-fonts:: cannot find target "${targetName}". If this target is created by another plugin (e.g. expo-widgets), ensure that plugin is listed AFTER expo-native-fonts in your app config plugins array so the target is created first.`)
    }

    console.log(`Target UUID: ${targetUuid}`)

    // Find the target's actual resources build phase (may have a non-standard comment).
    // This is needed because extension targets (e.g. widgets) may have their resources build
    // phase created with a non-standard comment like "Embed Foundation Extensions" instead of
    // "Resources", which causes the xcode library's addToPbxResourcesBuildPhase to fall back
    // to the main app target's build phase.
    const resourcesBuildPhase = getResourcesBuildPhaseForTarget(project, targetUuid)

    for (const filePath of fontFiles) {
        const fontPath = path.join('Fonts', filePath)
        const basename = path.basename(filePath)
        console.log(`Adding resource file ${fontPath}`)

        const fileRef = project.generateUuid()
        const buildFileUuid = project.generateUuid()

        // Add to PBXFileReference section
        const fileRefSection = project.pbxFileReferenceSection()
        fileRefSection[fileRef] = {
            isa: 'PBXFileReference',
            name: `"${basename}"`,
            path: `"${fontPath}"`,
            sourceTree: '"<group>"',
            lastKnownFileType: 'unknown',
            includeInIndex: 0,
        }
        fileRefSection[`${fileRef}_comment`] = basename

        // Add to PBXBuildFile section
        const buildFileSection = project.pbxBuildFileSection()
        buildFileSection[buildFileUuid] = {
            isa: 'PBXBuildFile',
            fileRef: fileRef,
            fileRef_comment: basename,
        }
        buildFileSection[`${buildFileUuid}_comment`] = `${basename} in Resources`

        // Add to the target's resources build phase directly
        if (resourcesBuildPhase) {
            resourcesBuildPhase.files.push({
                value: buildFileUuid,
                comment: `${basename} in Resources`,
            })
            console.log(`Added ${basename} to existing resources build phase for target ${targetName}`)
        } else {
            // Fallback: create a new resources build phase for this target
            console.log(`No resources build phase found for target ${targetName}, creating one`)
            project.addBuildPhase(
                [fontPath],
                'PBXResourcesBuildPhase',
                'Resources',
                targetUuid,
                'app_extension',
                '',
            )
        }

        // Add file reference to the widget target's PBXGroup
        const targetGroup = project.pbxGroupByName(targetName)
        if (targetGroup) {
            targetGroup.children.push({
                value: fileRef,
                comment: basename,
            })
            console.log(`Added ${basename} to group ${targetName}`)
        } else {
            // Fallback to the main Resources group
            const resourcesGroup = project.pbxGroupByName('Resources')
            if (resourcesGroup) {
                resourcesGroup.children.push({
                    value: fileRef,
                    comment: basename,
                })
                console.log(`Added ${basename} to Resources group`)
            }
        }
    }

    console.log('Resource files copied successfully.')
    config.modResults = project
    return config
}

const updateInfoPlist = (config: ExportedConfigWithProps<XcodeProject>, options: ExpoNativeFontsOptions, grouped: FontsGrouped) => {
    const {
        projectRoot,
    } = config.modRequest

    console.log('Updating Info.plist files')

    for (const targetName in grouped) {
        const targetFonts = grouped[targetName]
        const plistFilePath = path.join(projectRoot, 'ios', targetName, 'Info.plist')
        console.log(`plistFilePath: ${plistFilePath}`)

        if (!fsExtra.existsSync(plistFilePath)) {
            const directory = path.dirname(plistFilePath)

            if (!fsExtra.existsSync(directory)) {
                fsExtra.mkdirSync(directory, { recursive: true })
            }

            fsExtra.writeFileSync(plistFilePath, `<?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
            <plist version="1.0">
            <dict>
            </dict>
            </plist>
            `)
            //throw new Error(`There is no Info.plist file at ${plistFilePath}. You must ensure your target has a Info.plist file to add fonts.`)
        }
        
        const contents = fsExtra.readFileSync(plistFilePath, 'utf-8')
        const dictTag = '<dict>'
        const dictIndex = contents.indexOf(dictTag)
        let insertIndex = dictIndex + dictTag.length

        if (dictIndex === -1) {
            console.log(contents)
            console.log(`dictIndex: ${dictIndex}`)
            const plistEndIndex = contents.indexOf('</plist>')

            if (plistEndIndex === -1) {
                throw new Error(`Your Info.plist file at ${plistFilePath} does not have a <dict> or </plist> tag. Please add this to your file.`)
            }
            else {
                insertIndex = plistEndIndex;
            }
        }       
        
        const insertionKeys = targetFonts.reduce((contents, { filePath }) => {
            const name = path.basename(filePath)

            return `${contents}
            <string>${name}</string>`
        }, '')

        const insertionContents = `<key>UIAppFonts</key>
        <array>
        ${insertionKeys}
        </array>`

        const newPlistContents = contents.slice(0, insertIndex) + insertionContents + contents.slice(insertIndex)
        fsExtra.writeFileSync(plistFilePath, newPlistContents)
    }

    return config
}

const copyFontFilesToTarget = (config: ExportedConfigWithProps<XcodeProject>, options: ExpoNativeFontsOptions, targetName: string, fonts: ExpoNativeFontOptions[]) => {
    const { projectRoot } = config.modRequest
    const sourceDir = path.join(projectRoot, options.srcFolder)
    const targetFontsDir = path.join(projectRoot, 'ios', targetName, 'Fonts')

    if (!fsExtra.existsSync(targetFontsDir)) {
        fsExtra.mkdirSync(targetFontsDir, { recursive: true })
    }

    for (const font of fonts) {
        const src = path.join(sourceDir, font.filePath)
        const dest = path.join(targetFontsDir, font.filePath)
        const destDir = path.dirname(dest)

        if (!fsExtra.existsSync(destDir)) {
            fsExtra.mkdirSync(destDir, { recursive: true })
        }

        fsExtra.copySync(src, dest)
        console.log(`Copied ${font.filePath} to ${targetName}/Fonts/`)
    }
}

const copyFontFiles = (config: ExportedConfigWithProps<XcodeProject>, { srcFolder }: ExpoNativeFontsOptions) => {
    const {
        projectRoot,
    } = config.modRequest

    console.log(`Copying files`)
    const sourceDir = path.join(projectRoot, srcFolder)
    const targetDir = path.join(projectRoot, 'ios', 'Fonts')

    console.log(`SourceDir: ${sourceDir}`)
    console.log(`TargetDir: ${targetDir}`)

    if (!fsExtra.lstatSync(sourceDir).isDirectory()) {
        throw new Error(`The provided sourceDir is not a directory. This value must be the directory of your font files.`)
    }

    if (!fsExtra.existsSync(targetDir)) {
        fsExtra.mkdirSync(targetDir, { recursive: true });
    }

    fsExtra.copySync(sourceDir, targetDir)
    console.log(`Font files copied to ios/Fonts`)
}

/**
 * This is the plugin entry method
 * @param config 
 * @param options 
 * @returns 
 */
export const withExpoNativeFontsIOS: ConfigPlugin<ExpoNativeFontsOptions> = (config, options) => {
    return withXcodeProject(config, (config) => {
         injectExpoNativeFontsIOS(config, options)
         return config;
    })
}

/**
 * This is the entry other modules
 * @param config 
 * @param options 
 * @returns 
 */
export const injectExpoNativeFontsIOS = (config: ExportedConfigWithProps<XcodeProject>, options: ExpoNativeFontsOptions): XcodeProject => {
    const iosFonts = getIOSFonts(options)
    const grouped = groupByTarget(iosFonts)

    updateInfoPlist(config, options, grouped)
    updateXcodeProject(config, options, grouped)
}