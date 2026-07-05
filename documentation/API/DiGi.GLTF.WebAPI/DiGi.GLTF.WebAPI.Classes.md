#### [DiGi\.GLTF\.WebAPI](index.md 'index')

## DiGi\.GLTF\.WebAPI\.Classes Namespace
### Classes

<a name='DiGi.GLTF.WebAPI.Classes.GLTFSceneController'></a>

## GLTFSceneController Class

Controller responsible for composing generic [DiGi\.GLTF\.Classes\.GLTFScene](https://learn.microsoft.com/en-us/dotnet/api/digi.gltf.classes.gltfscene 'DiGi\.GLTF\.Classes\.GLTFScene') instances and converting them into binary glTF \(\.glb\) payloads\.

The controller is domain agnostic: it accepts only generic DiGi.GLTF payloads ([DiGi\.GLTF\.Classes\.GLTFScene](https://learn.microsoft.com/en-us/dotnet/api/digi.gltf.classes.gltfscene 'DiGi\.GLTF\.Classes\.GLTFScene'), [DiGi\.GLTF\.Classes\.GLTFNode](https://learn.microsoft.com/en-us/dotnet/api/digi.gltf.classes.gltfnode 'DiGi\.GLTF\.Classes\.GLTFNode')) or raw DiGi geometry. Domain objects must be converted to [DiGi\.GLTF\.Classes\.GLTFNode](https://learn.microsoft.com/en-us/dotnet/api/digi.gltf.classes.gltfnode 'DiGi\.GLTF\.Classes\.GLTFNode') instances by the consuming application before calling these endpoints.

```csharp
public class GLTFSceneController : DiGi.WebAPI.Classes.WebAPIController
```

Inheritance [System\.Object](https://learn.microsoft.com/en-us/dotnet/api/system.object 'System\.Object') → [Microsoft\.AspNetCore\.Mvc\.ControllerBase](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.controllerbase 'Microsoft\.AspNetCore\.Mvc\.ControllerBase') → [DiGi\.WebAPI\.Classes\.WebAPIController](https://learn.microsoft.com/en-us/dotnet/api/digi.webapi.classes.webapicontroller 'DiGi\.WebAPI\.Classes\.WebAPIController') → GLTFSceneController
### Methods

<a name='DiGi.GLTF.WebAPI.Classes.GLTFSceneController.FromObjects(System.Text.Json.Nodes.JsonArray,string)'></a>

## GLTFSceneController\.FromObjects\(JsonArray, string\) Method

Creates a [DiGi\.GLTF\.Classes\.GLTFScene](https://learn.microsoft.com/en-us/dotnet/api/digi.gltf.classes.gltfscene 'DiGi\.GLTF\.Classes\.GLTFScene') from the provided serialized generic objects \([DiGi\.GLTF\.Classes\.GLTFNode](https://learn.microsoft.com/en-us/dotnet/api/digi.gltf.classes.gltfnode 'DiGi\.GLTF\.Classes\.GLTFNode') instances or raw DiGi geometry\) by translating all geometry to a local origin and storing the offset in [DiGi\.GLTF\.Classes\.GLTFScene\.ReferencePoint](https://learn.microsoft.com/en-us/dotnet/api/digi.gltf.classes.gltfscene.referencepoint 'DiGi\.GLTF\.Classes\.GLTFScene\.ReferencePoint')\.

```csharp
public Microsoft.AspNetCore.Mvc.IActionResult FromObjects(System.Text.Json.Nodes.JsonArray? jsonArray, string? name=null);
```
#### Parameters

<a name='DiGi.GLTF.WebAPI.Classes.GLTFSceneController.FromObjects(System.Text.Json.Nodes.JsonArray,string).jsonArray'></a>

`jsonArray` [System\.Text\.Json\.Nodes\.JsonArray](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.nodes.jsonarray 'System\.Text\.Json\.Nodes\.JsonArray')

The JSON array with serialized [DiGi\.GLTF\.Classes\.GLTFNode](https://learn.microsoft.com/en-us/dotnet/api/digi.gltf.classes.gltfnode 'DiGi\.GLTF\.Classes\.GLTFNode') instances or raw DiGi geometry objects\.

<a name='DiGi.GLTF.WebAPI.Classes.GLTFSceneController.FromObjects(System.Text.Json.Nodes.JsonArray,string).name'></a>

`name` [System\.String](https://learn.microsoft.com/en-us/dotnet/api/system.string 'System\.String')

The optional display name of the scene\.

#### Returns
[Microsoft\.AspNetCore\.Mvc\.IActionResult](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.iactionresult 'Microsoft\.AspNetCore\.Mvc\.IActionResult')  
An [Microsoft\.AspNetCore\.Mvc\.IActionResult](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.iactionresult 'Microsoft\.AspNetCore\.Mvc\.IActionResult') holding the [DiGi\.GLTF\.Classes\.GLTFScene](https://learn.microsoft.com/en-us/dotnet/api/digi.gltf.classes.gltfscene 'DiGi\.GLTF\.Classes\.GLTFScene') JSON\.

<a name='DiGi.GLTF.WebAPI.Classes.GLTFSceneController.GLB(System.Text.Json.Nodes.JsonObject)'></a>

## GLTFSceneController\.GLB\(JsonObject\) Method

Converts the provided [DiGi\.GLTF\.Classes\.GLTFScene](https://learn.microsoft.com/en-us/dotnet/api/digi.gltf.classes.gltfscene 'DiGi\.GLTF\.Classes\.GLTFScene') JSON into a binary glTF \(\.glb\) file\.

```csharp
public Microsoft.AspNetCore.Mvc.IActionResult GLB(System.Text.Json.Nodes.JsonObject? jsonObject);
```
#### Parameters

<a name='DiGi.GLTF.WebAPI.Classes.GLTFSceneController.GLB(System.Text.Json.Nodes.JsonObject).jsonObject'></a>

`jsonObject` [System\.Text\.Json\.Nodes\.JsonObject](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.nodes.jsonobject 'System\.Text\.Json\.Nodes\.JsonObject')

The JSON object with the serialized [DiGi\.GLTF\.Classes\.GLTFScene](https://learn.microsoft.com/en-us/dotnet/api/digi.gltf.classes.gltfscene 'DiGi\.GLTF\.Classes\.GLTFScene')\.

#### Returns
[Microsoft\.AspNetCore\.Mvc\.IActionResult](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.iactionresult 'Microsoft\.AspNetCore\.Mvc\.IActionResult')  
An [Microsoft\.AspNetCore\.Mvc\.IActionResult](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.iactionresult 'Microsoft\.AspNetCore\.Mvc\.IActionResult') holding the \.glb file\.