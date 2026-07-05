using DiGi.Core;
using DiGi.Core.Interfaces;
using DiGi.GLTF.Classes;
using DiGi.WebAPI.Classes;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using System.Collections.Generic;
using System.Text.Json.Nodes;

namespace DiGi.GLTF.WebAPI.Classes
{
    /// <summary>
    /// Controller responsible for composing generic <see cref="GLTFScene"/> instances and converting them into binary glTF (.glb) payloads.
    /// <para>The controller is domain agnostic: it accepts only generic DiGi.GLTF payloads (<see cref="GLTFScene"/>, <see cref="GLTFNode"/>) or raw DiGi geometry. Domain objects must be converted to <see cref="GLTFNode"/> instances by the consuming application before calling these endpoints.</para>
    /// </summary>
    [ApiController]
    [Route("gltf/[controller]")]
    public class GLTFSceneController : WebAPIController
    {
        /// <summary>
        /// Creates a <see cref="GLTFScene"/> from the provided serialized generic objects (<see cref="GLTFNode"/> instances or raw DiGi geometry) by translating all geometry to a local origin and storing the offset in <see cref="GLTFScene.ReferencePoint"/>.
        /// </summary>
        /// <param name="jsonArray">The JSON array with serialized <see cref="GLTFNode"/> instances or raw DiGi geometry objects.</param>
        /// <param name="name">The optional display name of the scene.</param>
        /// <returns>An <see cref="IActionResult"/> holding the <see cref="GLTFScene"/> JSON.</returns>
        [HttpPost("fromobjects", Name = $"{nameof(GLTFSceneController)}_{nameof(FromObjects)}")]
        [ApiExplorerSettings(IgnoreApi = false)]
        [ProducesResponseType(typeof(GLTFScene), StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status204NoContent)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        public IActionResult FromObjects([FromBody] JsonArray? jsonArray, [FromQuery(Name = "name")] string? name = null)
        {
            Serilog.Modify.Log("{Type}:{Name} started", nameof(GLTFSceneController), nameof(FromObjects));

            if (jsonArray is null)
            {
                return BadRequest();
            }

            List<ISerializableObject>? serializableObjects = Core.Create.SerializableObjects<ISerializableObject>(jsonArray);
            if (serializableObjects is null || serializableObjects.Count == 0)
            {
                return NoContent();
            }

            GLTFScene? gLTFScene = Create.GLTFScene(serializableObjects, name);
            if (gLTFScene is null)
            {
                return NoContent();
            }

            string? json = gLTFScene.ToSystem_String();
            if (string.IsNullOrWhiteSpace(json))
            {
                return NoContent();
            }

            return Content(json, "application/json");
        }

        /// <summary>
        /// Converts the provided <see cref="GLTFScene"/> JSON into a binary glTF (.glb) file.
        /// </summary>
        /// <param name="jsonObject">The JSON object with the serialized <see cref="GLTFScene"/>.</param>
        /// <returns>An <see cref="IActionResult"/> holding the .glb file.</returns>
        [HttpPost("glb", Name = $"{nameof(GLTFSceneController)}_{nameof(GLB)}")]
        [ApiExplorerSettings(IgnoreApi = false)]
        [ProducesResponseType(typeof(FileContentResult), StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status204NoContent)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        public IActionResult GLB([FromBody] JsonObject? jsonObject)
        {
            Serilog.Modify.Log("{Type}:{Name} started", nameof(GLTFSceneController), nameof(GLB));

            if (jsonObject is null)
            {
                return BadRequest();
            }

            GLTFScene? gLTFScene = Core.Create.SerializableObject<GLTFScene>(jsonObject);
            if (gLTFScene is null)
            {
                return BadRequest();
            }

            byte[]? bytes = gLTFScene.ToSystem_Bytes();
            if (bytes is null || bytes.Length == 0)
            {
                return NoContent();
            }

            return File(bytes, "model/gltf-binary", $"{gLTFScene.Name ?? "scene"}.glb");
        }
    }
}
