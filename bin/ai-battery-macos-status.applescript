use framework "AppKit"
use framework "Foundation"
use scripting additions

property statusItem : missing value
property detailItem : missing value
property detailView : missing value
property refreshTimer : missing value
property titleCommand : ""
property detailCommand : ""
property tooltipCommand : ""
property refreshInterval : 10

on run argv
  if (count of argv) < 2 then error "ai-battery macOS status item requires title and detail commands"

  set titleCommand to item 1 of argv
  set detailCommand to item 2 of argv
  set tooltipCommand to detailCommand
  if (count of argv) is greater than or equal to 4 then
    set tooltipCommand to item 3 of argv
    try
      set refreshInterval to (item 4 of argv) as real
    end try
  else
    if (count of argv) is greater than or equal to 3 then
      try
        set refreshInterval to (item 3 of argv) as real
      end try
    end if
  end if

  current application's NSApplication's sharedApplication()
  current application's NSApp's setActivationPolicy:(current application's NSApplicationActivationPolicyAccessory)

  set statusItem to current application's NSStatusBar's systemStatusBar()'s statusItemWithLength:(current application's NSVariableStatusItemLength)
  statusItem's button()'s setTitle:"AI --"
  statusItem's button()'s setImagePosition:(current application's NSNoImage)
  statusItem's button()'s setToolTip:"AI Battery"

  set statusMenu to current application's NSMenu's alloc()'s initWithTitle:"AI Battery"
  set detailItem to current application's NSMenuItem's alloc()'s initWithTitle:"Loading..." action:(missing value) keyEquivalent:""
  detailItem's setEnabled:false
  statusMenu's addItem:detailItem
  statusMenu's addItem:(current application's NSMenuItem's separatorItem())

  set refreshItem to current application's NSMenuItem's alloc()'s initWithTitle:"Refresh" action:"refresh:" keyEquivalent:"r"
  refreshItem's setTarget:me
  statusMenu's addItem:refreshItem

  set quitItem to current application's NSMenuItem's alloc()'s initWithTitle:"Quit AI Battery" action:"quit:" keyEquivalent:"q"
  quitItem's setTarget:me
  statusMenu's addItem:quitItem

  statusItem's setMenu:statusMenu
  my refresh_(missing value)

  set refreshTimer to current application's NSTimer's scheduledTimerWithTimeInterval:refreshInterval target:me selector:"refresh:" userInfo:(missing value) repeats:true
  current application's NSRunLoop's currentRunLoop()'s addTimer:refreshTimer forMode:(current application's NSRunLoopCommonModes)
  current application's NSApp's |run|()
end run

on refresh_(sender)
  set titleText to "AI --"
  set detailText to "AI Battery unavailable"
  set tooltipText to "AI Battery unavailable"
  set imagePath to ""
  set menuImage to missing value
  set detailImage to missing value

  try
    set imagePath to (do shell script (titleCommand as text))
  end try

  try
    set detailText to (do shell script (detailCommand as text))
  end try

  try
    set tooltipText to (do shell script (tooltipCommand as text))
  end try

  if imagePath is "" then set imagePath to "AI --"
  if detailText is "" then set detailText to "AI Battery unavailable"
  if tooltipText is "" then set tooltipText to detailText

  try
    set menuImage to current application's NSImage's alloc()'s initWithContentsOfFile:imagePath
  end try

  try
    set detailImage to current application's NSImage's alloc()'s initWithContentsOfFile:detailText
  end try

  if menuImage is not missing value then
    set imageSize to menuImage's |size|()
    statusItem's setLength:(width of imageSize)
    menuImage's setTemplate:false
    statusItem's button()'s setImage:menuImage
    statusItem's button()'s setImageScaling:(current application's NSImageScaleProportionallyDown)
    statusItem's button()'s setImagePosition:(current application's NSImageOnly)
    statusItem's button()'s setTitle:""
  else
    set titleText to imagePath
    if titleText is "" then set titleText to "AI --"
    statusItem's setLength:(current application's NSVariableStatusItemLength)
    statusItem's button()'s setImage:(missing value)
    statusItem's button()'s setImagePosition:(current application's NSNoImage)
    statusItem's button()'s setTitle:titleText
  end if

  if detailImage is not missing value then
    set detailSize to detailImage's |size|()
    set detailFrame to current application's NSMakeRect(0, 0, (width of detailSize), (height of detailSize))
    set detailView to current application's NSImageView's alloc()'s initWithFrame:detailFrame
    detailView's setImage:detailImage
    detailView's setImageScaling:(current application's NSImageScaleNone)
    detailItem's setView:detailView
    detailItem's setTitle:""
  else
    detailItem's setView:(missing value)
    detailItem's setTitle:detailText
  end if

  statusItem's button()'s setToolTip:tooltipText
end refresh_

on quit_(sender)
  try
    refreshTimer's invalidate()
  end try
  current application's NSStatusBar's systemStatusBar()'s removeStatusItem:statusItem
  current application's NSApp's terminate:me
end quit_
